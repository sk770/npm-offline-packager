const { get } = require('axios').default;

/**
 * Get top packages from npm api
 *
 * @param {number} quantity How many packages to fetch (max: 5250)
 * @param {any} options The options
 */
async function getNpmTopPackages(quantity = 1000, options = {}) {
    const logger = options.logger || (() => { });
    const packagesQuantity = Math.min(quantity, 5250);
    const chunks = Math.ceil(packagesQuantity / 250);
    const lastChunk = packagesQuantity % 250;
    const packages = [];

    for (let index = 1; index <= chunks; index += 1) {
        const size = (index < chunks || lastChunk === 0) ? 250 : lastChunk;
        const from = (index - 1) * 250;

        const { data } = await get(`http://registry.npmjs.com/-/v1/search?text=boost-exact:false&popularity=1.0&quality=1.0&maintenance=1.0&size=${size}&from=${from}`);

        data.objects.forEach((obj) => {
            const newPackage = {
                name: obj.package.name,
                version: obj.package.version,
                score: obj.score,
            };

            packages.push(newPackage);
        });

        const percent = (packages.length / packagesQuantity);
        logger(`Fetch top ${packagesQuantity} npm packages...`, percent);
    }

    return packages;
}

module.exports = {
    getNpmTopPackages,
};
