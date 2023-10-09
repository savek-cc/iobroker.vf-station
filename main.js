'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require("fs");
const tough = require('tough-cookie');
const acs = require('axios-cookiejar-support');
const axios = require('axios');
const qs = require('querystring');
const crypto = require('crypto');
const {adapter} = require('@iobroker/adapter-core');

let updateInterval;

/**
 * @param {{ log: { debug: (arg0: string) => void; }; getObject: (arg0: string) => any; setObjectNotExists: (arg0: string, arg1: { type: string; common: { name: string; type: string; // This may vary depending on the data type you expect.
role: string; read: boolean; write: boolean; }; native: {}; }) => void; setState: (arg0: string, arg1: { val: any; ack: boolean; }) => void; }} adapter
 * @param {{data: {[x: string]: any;};}} statusData
 * @param {string} prefix
 */
/**
 * @this {any}
 */
async function fetchData(){
    function parseValue(str) {
        const match = str.match(/^([+-]?\d+(\.\d+)?)\s?([a-zA-Z]*)$/);
        if (!match) return null;

        return {
            number: parseFloat(match[1]),
            unit: match[3] || null
        };
    }

    function createObject(key, value) {
        const parsed = parseValue(value);
        const isNumberType = parsed && (typeof parsed.number === 'number');

        const commonAttributes = {
            name: key,
            type: isNumberType ? 'number' : 'mixed',
            role: 'value',
            read: true,
            write: false
        };

        if (isNumberType && parsed.unit) {
            commonAttributes.unit = parsed.unit;
        }

        return {
            type: 'state',
            common: commonAttributes,
            native: {}
        };
    }

    /**
     * @param {{ data: { [x: string]: any; }; }} statusData
     * @param {string} prefix
     */
    async function storeData(statusData, prefix) {
        if (!statusData || !statusData.data) return;

        for (const [key, rawValue] of Object.entries(statusData.data)) {
            const stateId = `${prefix}.${key}`;
            const value = Array.isArray(rawValue) ? JSON.stringify(rawValue) : rawValue;

            if (!(await this.getObjectAsync(stateId))) {
                const obj = createObject(key, value);
                await this.setObjectNotExistsAsync(stateId, obj);
            }

            const parsed = parseValue(value);
            const stateValue = parsed && typeof parsed.number === 'number' ? parsed.number : value;
            await this.setStateAsync(stateId, {val: stateValue, ack: true});
        }
    }
    async function storeDocsis(docsisData, prefix) {
        if (docsisData && docsisData.data) {
            for (const key of Object.keys(docsisData.data)) {
                const stateId = `${prefix}.${key}`;
                const valueArray = docsisData.data[key];

                for (const dataObj of valueArray) {
                    const channelId = `${stateId}.${dataObj.__id}`;

                    // Create the channel first
                    const channelExists = await this.getObjectAsync(channelId);
                    if (!channelExists) {
                        await this.setObjectNotExistsAsync(channelId, { type: 'channel', common: { name: `Channel ${dataObj.__id}` }, native: {}});
                    }

                    // Once the channel is created or confirmed to exist, create the states
                    for (const [stateKey, stateValue] of Object.entries(dataObj)) {
                        if (stateKey !== '__id') { // We don't need to create a state for __id since it's used as the channel ID
                            const objectPath = `${channelId}.${stateKey}`;
                            const obj = createObject(stateKey, stateValue);

                            const stateObjectExists = await this.getObjectAsync(objectPath);
                            if (!stateObjectExists) {
                                await this.setObjectNotExistsAsync(objectPath, obj);
                            }

                            // Parse the value and determine if it should be stored as a number or as its original type
                            const parsed = parseValue(stateValue);
                            const finalStateValue = parsed && typeof parsed.number === 'number' ? parsed.number : stateValue;
                            await this.setStateAsync(objectPath, { val: finalStateValue, ack: true });
                        }
                    }
                }
            }
        }
    }

    const storeDataBound = storeData.bind(this);
    const storeDocsisBound = storeDocsis.bind(this);
    try {
        this.log.debug(`Performing login to vodafone station at ip ${this.config.ip} and retrieving data.`);
        await this.station.login(`http://${this.config.ip}`, this.config.password);
        this.log.debug('fetching station status');
        const statusData = await this.station.getStationStatus();
        this.log.debug('storing station status');
        storeDataBound(statusData, 'status');
        this.log.debug('fetching docsis status');
        const docsisData = await this.station.getDocsisStatus();
        this.log.debug('storing docsis status');
        storeDocsisBound(docsisData, 'docsis');
    } catch (err) {
        this.log.error(`Failed fetching data: ${err.toString()}`);
    }
}

class VfStation extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'vf-station',
        });
        this.station = new VodafoneStation();
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        const boundFetch = fetchData.bind(this);
        const refreshInterval = this.config.refresh * 1000 || 60000;
        if (updateInterval) {
            clearInterval(updateInterval);
        }
        this.log.info(`Scheduling status updates every ${refreshInterval/1000} seconds.`);
        updateInterval = setInterval(boundFetch, refreshInterval);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    async onUnload(callback) {
        try {
            if (updateInterval) {
                clearInterval(updateInterval);
            }
            await this.station.logout();
            callback();
        } catch (e) {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // onObjectChange(id, obj) {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }

}

class VodafoneStation {
    constructor() {
        this.cookieJar = new tough.CookieJar();
        this.axiosInstance = acs.wrapper(axios.create({
            timeout: 10000, // 10 seconds, adjust as needed
            withCredentials: true, // Allows cross-site requests to carry credentials (cookies)
            baseURL: 'http://192.168.100.1',
            headers: {
                'Referer': 'http://192.168.100.1',
                'X-Requested-With': 'XMLHttpRequest',
            },
            jar: this.cookieJar // Attach the cookie jar
        }));
    }

    /**
     * @param {string} stationUrl
     * @param {string} password
     */
    async login(stationUrl, password) {
        try {
            // First request to get cookies
            await this.axiosInstance.get('/');

            const loginResponseSalts = await this.getLoginSalts();
            const derivedPassword = this.getLoginPassword(password, loginResponseSalts.salt, loginResponseSalts.saltWebUI);

            const response = await this.axiosInstance.post('/api/v1/session/login', qs.stringify({
                username: 'admin',
                password: derivedPassword
            }));

            // Check if login was successful and proceed further
            if (response.data && response.data.error === 'ok') {
                await this.axiosInstance.get('/api/v1/session/menu?_=' + Date.now().toString(10));
                return response.data;
            } else {
                throw new Error('Login failed');
            }
        } catch (error) {
            console.error('Error during login:', error);
            throw error;
        }
    }

    async getLoginSalts() {
        try {
            const response = await this.axiosInstance.post('/api/v1/session/login', qs.stringify({
                username: 'admin',
                password: 'seeksalthash',
                logout: true
            }));
            if (response.data && response.data.error === 'ok') {
                return {
                    salt: response.data.salt,
                    saltWebUI: response.data.saltwebui
                };
            } else {
                throw new Error('Failed to get salts');
            }
        } catch (error) {
            console.error('Error fetching salts:', error);
            throw error;
        }
    }

    /**
     * @param {string} password
     * @param {string} salt
     * @param {string} saltWebUI
     */
    getLoginPassword(password, salt, saltWebUI) {
        const hashed1 = this.doPbkdf2NotCoded(password, salt);
        return this.doPbkdf2NotCoded(hashed1, saltWebUI);
    }

    /**
     * @param {string} key
     * @param {string} salt
     */
    doPbkdf2NotCoded(key, salt) {
        const derivedKey = crypto.pbkdf2Sync(key, salt, 1000, 16, 'sha256');
        return derivedKey.toString('hex');
    }

    /**
     * @param {string} path
     */
    async apiGet(path) {
        try {
            const response = await this.axiosInstance.get(`/api/v1/${path}?_=${Date.now().toString(10)}`);
            return response.data;
        } catch (error) {
            console.error('Error fetching data from ${path}:', error);
            throw error;
        }
    }

    /**
     * @param {string} path
     * @param {any} parameters
     */
    async apiPost(path, parameters = null) {
        try {
            const response = await this.axiosInstance.post(`/api/v1/${path}`, parameters);
            return response.data;
        } catch (error) {
            console.error(`Error posting data to ${path}:`, error);
            throw error;
        }
    }

    async getStationStatus() {
        return this.apiGet('sta_status');
    }

    async getDocsisStatus() {
        return this.apiGet('sta_docsis_status');
    }

    async getAbout() {
        return this.apiGet('sta_about');
    }

    async restart() {
        return this.apiPost('sta_restart');
    }

    async logout() {
        try {
            const response = await this.apiPost('session/logout');
            if (response && response.error === 'ok') {
                return true;
            } else {
                throw new Error('Failed to logout');
            }
        } catch (error) {
            console.error('Error during logout:', error);
            throw error;
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new VfStation(options);
} else {
    // otherwise start the instance directly
    new VfStation();
}