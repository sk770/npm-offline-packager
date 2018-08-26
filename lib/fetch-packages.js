const pacote = require('pacote');
const semver = require('semver');
const { merge } = require('lodash');
const conf = require('npm-conf')();
const { createWriteStream } = require('fs');
const { join } = require('path');
const { filter, map } = require('bluebird');
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

    // If cache enabled filter the dependencies that exist inn cache
    const packagesToDownload = useCache ? await filter(packages, ({ name, version }) => cache.exist(name, version).then(exist => !exist)) : packages;

    // Download packages tarballs and add them to cache
    const result = await map(packagesToDownload, ({ name, version, isLatest }) => downloadPackageTarball(name, version, { destFolder, isLatest }))
        .each(({ name, version }, index, length) => {
            const percent = (1 / length) * (index + 1);
            logger(`Fetching packages: ${name}@${version}`, percent);

            return useCache ? cache.add(name, version) : 1;
        })
        .all();

    return result;
}

/**
 * Download package tarball to dest folder
 *
 * @param {string} name The package name
 * @param {string} version The package version
 * @param {{destFolder: string, isLatest: boolean}} options The options
 */
function downloadPackageTarball(name, version, options) {
    const { destFolder, isLatest } = options;
    return new Promise((resolve, reject) => {
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
    const result = await filter(dependencies, ({ name, version }) => !resolvedPackages.get(name, version))
        .map(({ name, version }) => getPackageManifest(name, version).catch(console.error))
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
            const dependenciesChilds = await resolveDependencies(currManifest, { ...options, depth: options.depth + 1 });

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

module.exports = {
    getPackageManifest,
    resolveDependencies,
    downloadPackageTarball,
    downloadPackages,
};
