const { resolveDependencies, downloadPackages } = require('./lib/fetch-packages');
const { publishFolder, publishTarball } = require('./lib/npm-publish');

module.exports = {
    resolveDependencies,
    downloadPackages,
    publishFolder,
    publishTarball,
};
