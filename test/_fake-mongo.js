// ZA-901. An in-memory MongoDB stand-in for the billing tests: the query and
// update operators the billing stores use, dotted paths, unique (partial)
// indexes with E11000 errors, atomic single-document updates, and a
// snapshot-and-rollback withTransaction. No network, no driver.

function getPath(doc, path) {
	let cur = doc;
	for (const part of path.split('.')) {
		if (cur === null || cur === undefined) return undefined;
		cur = cur[part];
	}
	return cur;
}

function setPath(doc, path, value) {
	const parts = path.split('.');
	let cur = doc;
	for (const part of parts.slice(0, -1)) {
		if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {};
		cur = cur[part];
	}
	cur[parts[parts.length - 1]] = value;
}

function unsetPath(doc, path) {
	const parts = path.split('.');
	let cur = doc;
	for (const part of parts.slice(0, -1)) {
		if (cur === null || typeof cur !== 'object') return;
		cur = cur[part];
	}
	if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

function matchValue(value, cond) {
	if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
		return Object.entries(cond).every(([op, arg]) => {
			switch (op) {
				case '$gt': return value !== undefined && value !== null && value > arg;
				case '$gte': return value !== undefined && value !== null && value >= arg;
				case '$lt': return value !== undefined && value !== null && value < arg;
				case '$lte': return value !== undefined && value !== null && value <= arg;
				case '$ne': return value !== arg && !(arg === null && value === undefined);
				case '$in': return arg.some((a) => a === value || (a === null && value === undefined));
				case '$exists': return (value !== undefined) === arg;
				case '$type': return arg === 'string' ? typeof value === 'string' : false;
				default: throw new Error(`fake mongo: unsupported operator ${op}`);
			}
		});
	}
	if (cond === null) return value === null || value === undefined;
	return value === cond;
}

export function matches(doc, filter) {
	return Object.entries(filter).every(([key, cond]) => {
		if (key === '$or') return cond.some((f) => matches(doc, f));
		if (key === '$and') return cond.every((f) => matches(doc, f));
		return matchValue(getPath(doc, key), cond);
	});
}

function applyUpdate(doc, update) {
	for (const [op, fields] of Object.entries(update)) {
		for (const [path, value] of Object.entries(fields)) {
			if (op === '$set') setPath(doc, path, structuredClone(value));
			else if (op === '$unset') unsetPath(doc, path);
			else if (op === '$inc') setPath(doc, path, (getPath(doc, path) || 0) + value);
			else if (op === '$setOnInsert') continue;
			else throw new Error(`fake mongo: unsupported update ${op}`);
		}
	}
}

function duplicateKey(name) {
	const err = new Error(`E11000 duplicate key error index: ${name}`);
	err.code = 11000;
	return err;
}

export function fakeMongoCollection(name = 'c') {
	const docs = new Map();
	const indexes = [];
	const calls = { writes: 0 };

	function checkUnique(candidate) {
		for (const { key, options } of indexes) {
			if (!options || !options.unique) continue;
			const fields = Object.keys(key);
			const values = fields.map((f) => getPath(candidate, f));
			if (options.partialFilterExpression && !matches(candidate, options.partialFilterExpression)) continue;
			if (values.some((v) => v === undefined || v === null)) continue;
			for (const other of docs.values()) {
				if (other._id === candidate._id) continue;
				if (fields.every((f, i) => getPath(other, f) === values[i])) throw duplicateKey(options.name);
			}
		}
	}

	function find(filter) {
		for (const doc of docs.values()) if (matches(doc, filter)) return doc;
		return null;
	}

	return {
		name,
		docs,
		indexes,
		calls,
		async createIndex(key, options = {}) {
			const exists = indexes.some((i) => JSON.stringify(i.key) === JSON.stringify(key) && JSON.stringify(i.options) === JSON.stringify(options));
			if (!exists) indexes.push({ key, options });
		},
		async insertOne(doc) {
			calls.writes++;
			if (docs.has(doc._id)) throw duplicateKey('_id_');
			const copy = structuredClone(doc);
			checkUnique(copy);
			docs.set(copy._id, copy);
			return { insertedId: copy._id };
		},
		async findOne(filter) {
			const doc = find(filter);
			return doc ? structuredClone(doc) : null;
		},
		find(filter = {}) {
			const out = [...docs.values()].filter((d) => matches(d, filter)).map((d) => structuredClone(d));
			return { toArray: async () => out };
		},
		async updateOne(filter, update) {
			calls.writes++;
			const doc = find(filter);
			if (!doc) return { matchedCount: 0, modifiedCount: 0 };
			const next = structuredClone(doc);
			applyUpdate(next, update);
			checkUnique(next);
			docs.set(doc._id, next);
			return { matchedCount: 1, modifiedCount: 1 };
		},
		async findOneAndUpdate(filter, update, options = {}) {
			calls.writes++;
			let doc = find(filter);
			if (!doc) {
				if (!options.upsert) return null;
				const seed = {};
				for (const [k, v] of Object.entries(filter)) {
					if (k[0] !== '$' && (v === null || typeof v !== 'object')) setPath(seed, k, v);
				}
				if (docs.has(seed._id)) throw duplicateKey('_id_');
				const next = seed;
				applyUpdate(next, update);
				for (const [k, v] of Object.entries(update.$setOnInsert || {})) setPath(next, k, v);
				checkUnique(next);
				docs.set(next._id, next);
				return options.returnDocument === 'after' ? structuredClone(next) : null;
			}
			const before = structuredClone(doc);
			const next = structuredClone(doc);
			applyUpdate(next, update);
			checkUnique(next);
			docs.set(doc._id, next);
			return options.returnDocument === 'after' ? structuredClone(next) : before;
		},
	};
}

// A set of named collections sharing one rollback boundary.
export function fakeBillingDb(names = ['users', 'events', 'leases', 'catalog', 'audit']) {
	const collections = Object.fromEntries(names.map((n) => [n, fakeMongoCollection(n)]));
	async function withTransaction(fn) {
		const snapshot = Object.fromEntries(
			Object.entries(collections).map(([n, c]) => [n, new Map([...c.docs].map(([k, v]) => [k, structuredClone(v)]))])
		);
		try {
			return await fn({ session: { fake: true } });
		} catch (err) {
			for (const [n, c] of Object.entries(collections)) {
				c.docs.clear();
				for (const [k, v] of snapshot[n]) c.docs.set(k, v);
			}
			throw err;
		}
	}
	return { collections, withTransaction };
}
