/* eslint-disable no-shadow */
const Datastore = require('nedb');
const homedir = require('os').homedir();

/**
 * In memory cache for resolved packages
 */
class InMemoryCache {
    constructor() {
        this.cache = {};
    }

    set(packageName, packageVersion) {
        return this.cache[`${packageName}@${packageVersion}`] = true;
    }

    get(packageName, packageVersion) {
        return !!this.cache[`${packageName}@${packageVersion}`];
    }

    clean() {
        this.cache = {};
    }
}

/**
 * Local db cache with nedb for packages
 */
class DBCache {
    constructor(filename) {
        this.db = new Datastore({ filename, autoload: true });
    }

    /**
     * Add package to cache
     *
     * @param {string} packageName The package name
     * @param {string} packagesVersion The package version
     *
     * @returns {Promise<any>} The package from cache
     */
    add(packageName, packagesVersion) {
        return new Promise((resolve, reject) => {
            this.db.findOne({ packageName }, (err, doc) => {
                if (err) return reject(err);

                if (doc && doc.versions.includes(packagesVersion)) return resolve(doc);

                if (doc) {
                    this.db.update(
                        { packageName },
                        { $push: { versions: packagesVersion } },
                        { multi: false, upsert: false },
                        (err) => {
                            if (err) return reject(err);

                            doc.versions.push(packagesVersion);
                            resolve(doc);
                        },
                    );
                } else {
                    this.db.insert({
                        packageName,
                        versions: [packagesVersion],
                    }, (err, doc) => {
                        if (err) return reject(err);
                        resolve(doc);
                    });
                }
            });
        });
    }

    /**
     * Is package in cache
     *
     * @param {string} packageName The package name
     * @param {string} packagesVersion The package version
     *
     * @returns {Promise<boolean>} Is package in cache
     */
    exist(packageName, packagesVersion) {
        return new Promise((resolve) => {
            this.db.findOne({ packageName, versions: packagesVersion }, (err, doc) => {
                if (err) {
                    console.error(err);
                }

                resolve(!err && !!doc);
            });
        });
    }

    clean() {
        return this.db.remove({});
    }
}

module.exports = {
    resolvedPackages: new InMemoryCache(),
    cache: new DBCache(`${homedir}/.npm-offline-packager/db/packages-cache.db`),
};
