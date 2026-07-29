/** @type {import('lint-staged').Configuration} */
module.exports = {
  '*.{ts,mjs,js,cjs}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
