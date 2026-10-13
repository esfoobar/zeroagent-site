// ZA-901. Driver-free helper so the billing logic modules and their tests
// never import the MongoDB driver.
export function isDuplicateKeyError(err) {
	return Boolean(err) && (err.code === 11000 || /duplicate key/i.test(String(err.message || '')));
}
