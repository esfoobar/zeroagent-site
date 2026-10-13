// Shared test helper: an in-memory stand-in for a MongoDB collection that
// understands the few query shapes the web session store uses (equality,
// null equality and { $gt }), with atomic findOneAndUpdate semantics.
export function fakeCollection() {
	const docs = new Map();

	function matches(doc, filter) {
		return Object.entries(filter).every(([key, cond]) => {
			const value = doc[key];
			if (cond && typeof cond === 'object' && '$gt' in cond) return value > cond.$gt;
			return value === cond;
		});
	}

	function find(filter) {
		for (const doc of docs.values()) if (matches(doc, filter)) return doc;
		return null;
	}

	return {
		docs,
		async insertOne(doc) {
			if (docs.has(doc._id)) throw new Error('duplicate key');
			docs.set(doc._id, { ...doc });
		},
		async findOne(filter) {
			const doc = find(filter);
			return doc ? { ...doc } : null;
		},
		async updateOne(filter, update) {
			const doc = find(filter);
			if (doc) Object.assign(doc, update.$set);
		},
		async findOneAndUpdate(filter, update, options = {}) {
			const doc = find(filter);
			if (!doc) return null;
			const before = { ...doc };
			Object.assign(doc, update.$set);
			return options.returnDocument === 'after' ? { ...doc } : before;
		},
	};
}
