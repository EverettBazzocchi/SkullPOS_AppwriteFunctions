// Each function's source uses ESM (import/export, "type": "module" in its
// own package.json) since that's what Appwrite's Node runtime expects.
// Transpiling to CommonJS here is just for Jest -- it doesn't affect what
// actually gets deployed.
module.exports = {
	presets: [["@babel/preset-env", { targets: { node: "current" } }]],
};
