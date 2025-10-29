import { error } from "firebase-functions/logger";
/**
 * Get a validated price value.
 *
 * @param {string} priceName - The name of the price for error messages.
 * @param {string} customPrice - The custom price input as a string.
 * @param {number} defaultPrice - The default price to use if validation fails.
 * @param {number} minPrice - The minimum allowed price.
 * @param {number} maxPrice - The maximum allowed price.
 * @returns {number} The validated price.
 */
const getPrice = (priceName, customPrice, defaultPrice, minPrice, maxPrice) => {
    try {
        const customPriceNumber = parseFloat(customPrice);

        if (!isFinite(customPriceNumber)) {
            throw new Error(`Invalid price for ${priceName} - NaN/Infinite.`);
        } else if (customPriceNumber < 0) {
            throw new Error(
                `Invalid price for ${priceName} - price must be greater than 0.`,
            );
        } else if (customPriceNumber < minPrice) {
            throw new Error(
                `Invalid price for ${priceName} - below minimum allowed price of $${minPrice} per gb.`,
            );
        } else if (customPriceNumber > maxPrice) {
            throw new Error(
                `Invalid price for ${priceName} - above maximum allowed price of $${maxPrice} per gb.`,
            );
        }

        return customPriceNumber;
    } catch (e) {
        error(
            `Error with custom cost configuration (${priceName}): ${e.message}. Using default of $${defaultPrice}.`,
        );
        return defaultPrice;
    }
};

export default getPrice;
