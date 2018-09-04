const pacote = require('pacote');
const semver = require('semver');
const Bluebird = require('bluebird');
const { merge } = require('lodash');
const conf = require('npm-conf')();
const { createWriteStream } = require('fs');
const { red } = require('chalk').default;
const { join } = require('path');
const { cache, resolvedPackages } = require('./cache');

// Set cache folder to npm cache folder
const pacoteCacheFolder = process.env.CACHE_FOLDER || join(conf.get('cache'), '_cacache');

/**
 * Download packages tarball
 *
 * @param {{ name: string, version:string, isLatest: boolean }[]} packages The packages array
 * @param {any} options The options
 */
async function downloadPackages(packages, options = {}) {
    const logger = options.logger || (() => { });
    const destFolder = options.destFolder || '.';
    const { useCache } = options;
    let counter = 0;

    // If cache enabled filter the dependencies that exist inn cache
    const packagesToDownload = useCache ? (await Bluebird.filter(packages, ({ name, version }) => cache.exist(name, version).then(exist => !exist))) : packages;

    // Download packages tarballs and add them to cache
    const result = await Bluebird.map(packagesToDownload, ({ name, version, isLatest }) =>
        downloadPackageTarball(name, version, { destFolder, isLatest })
            .reflect()
            .then(inspection => {
                counter++;

                if (inspection.isFulfilled()) {
                    const { name, version } = inspection.value();

                    const percent = (1 / packagesToDownload.length) * counter;
                    logger(`Fetching packages: ${name}@${version}`, percent);

                    return useCache ? cache.add(name, version).then(() => inspection) : inspection;
                } else {
                    const error = inspection.reason();
                    handlerError(error);
                
                    return inspection
                }

            }))
            .all()

    return result;
}

/**
 * Download package tarball to dest folder
 *
 * @param {string} name The package name
 * @param {string} version The package version
 * @param {{destFolder: string, isLatest?: boolean}} options The options
 * 
 * @returns {Bluebird<{name: string, version:string, isLatest: boolean }>}
 */
function downloadPackageTarball(name, version = 'latest', options = { destFolder: '.' }) {
    const { destFolder, isLatest } = options;
    return new Bluebird((resolve, reject) => {
        pacote.tarball.stream(`${name}@${version}`, { cache: pacoteCacheFolder })
            .on('error', (err) => {
                reject(err);
            })
            .pipe(createWriteStream(`${destFolder}/${name.replace('/', '-')}-${version}${isLatest ? '-latest' : ''}.tgz`))
            .on('finish', () => {
                resolve({ name, version, isLatest: !!isLatest });
            });
    });
}

/**
 * Get package dependencies from manifest
 *
 * @param {object} manifest The package manifest
 * @param {object} options the options
 *
 * @returns {{name: string, version: string}[]} Array of dependencies
 */
function getManifestDependencies(manifest, options = {}) {
    const packages = merge(
        manifest.dependencies,
        options.dev ? manifest.devDependencies : {},
        options.peer ? manifest.peerDependencies : {},
        options.optional ? manifest.optionalDependencies : {},
    );

    return Object.keys(packages).map((name) => {
        let version = packages[name];
        let cleanVersion = version.replace('^', '').replace('~', '');

        if (!semver.valid(cleanVersion)) {
            const coerceVersion = semver.coerce(cleanVersion);
            version = !coerceVersion ? 'latest' : coerceVersion.version;
            cleanVersion = version;
        }

        return {
            name,
            version,
        };
    });
}

/**
 * Resolve all package dependencies recursively
 *
 * @param {any} manifest The package manifest (package.json file)
 * @param {any} options The options
 *
 * @returns {Promise<{ name: string, version:string, isLatest: boolean }[]>} Promise of dependencies array
 */
async function resolveDependencies(manifest, options) {
    const logger = options.logger || (() => { });

    // Get dependencies array from manifest
    const dependencies = getManifestDependencies(manifest, options);

    // Return a empty array in case of no dependencies
    if (!dependencies.length) {
        return [];
    }

    options.depth = options.depth || 0;
    options.progress = options.progress || 0;

    // Resolve dependencies childs recursively
    const result = await Bluebird.filter(dependencies, ({ name, version }) => !resolvedPackages.get(name, version))
        .map(({ name, version }) => getPackageManifest(name, version).catch(handlerError))
        // Chack if package with real version already added
        .filter(currManifest => currManifest && !resolvedPackages.get(currManifest.name, currManifest.version))
        // Add package version to cache (in memory)
        .each(({ name, version }) => {
            logger(`Resolving dependencies: ${name}@${version}`, options.progress);
            resolvedPackages.set(name, version);
        })
        // reduce packages to dependencies result
        .reduce(async (packages, currManifest) => {
            packages.push({ name: currManifest.name, version: currManifest.version, isLatest: currManifest.isLatest });
            const dependenciesChilds = await resolveDependencies(currManifest, Object.assign(options, { depth: options.depth + 1 }));

            // Add the current percent to progress bar (calculate only in packages at the top of the tree)
            if (options.depth === 0) {
                options.progress += 1 / dependencies.length;
            }

            // Concat dependencies to array result
            return packages.concat(dependenciesChilds);
        }, []);


    return result;
}

/**
 *  Get package manifest from npm (package.json file), use npm cache folder
 *
 * @param {string} packageName
 * @param {string} packageVersion
 */
function getPackageManifest(packageName, packageVersion = 'latest') {
    const pacoteOptions = { cache: pacoteCacheFolder };

    return Promise.all([
        pacote.manifest(`${packageName}@${packageVersion}`, pacoteOptions)
            .catch((error) => {
                if (error.code === 'ETARGET') {
                    const { latest } = error.distTags;
                    return pacote.manifest(`${packageName}@${latest}`, pacoteOptions);
                }

                if (error.code === 'E404') {
                    console.error(`\nError: "${packageName}@${packageVersion}" not found`);
                    return packageVersion !== 'latest' ? pacote.manifest(packageName, pacoteOptions)
                        : Promise.reject(new Error(`${packageName}@${packageVersion} not found`));
                }

                return Promise.reject(error);
            }),
        packageVersion !== 'latest' ? pacote.packument(packageName, pacoteOptions) : Promise.resolve(),
    ])
        .then(([manifest, packument]) => {
            if (packument) {
                manifest.isLatest = packument['dist-tags'].latest === manifest.version;
            } else {
                manifest.isLatest = true;
            }

            return manifest;
        });
}

/**
 * Print promise catch error
 *
 * @param {Error} error
 */
function handlerError(error) {
    console.log(error && error.message ? red(error.message) : error);
}

module.exports = {
    getPackageManifest,
    resolveDependencies,
    downloadPackageTarball,
    downloadPackages,
};
