const exec = require('child_process').exec;
const path = require('path');
const mqtt = require('mqtt');
const scriptPath = path.join(__dirname, 'eq3.exp');

let Service, Characteristic;

module.exports = (homebridge) => {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	homebridge.registerAccessory('homebridge-eq3hk', 'EQ3Thermostat', EQ3Thermostat);
};

class EQ3Thermostat {
	constructor(log, config) {
		this.log = log;
		this.name = config.name;
		this.macAddress = config.macAddress;
		this.mqttUrl = config.mqttUrl;
		this.mqttTopic = config.mqttTopic || 'homebridge/eq3hk';
		this.lastUpdated = 0;
		this.cacheDuration = (config.cacheDuration || 300) * 1000;
		this.requestCooldown = 5 * 1000; // 5 seconds
		this.lastRequestTime = 0;
		this.cachedTemperature = 20.0; // Default value
		this.client = mqtt.connect(this.mqttUrl);

		this.client.on('connect', () => {
			this.log('MQTT connected');
			this.client.subscribe(`${this.mqttTopic}/response`);
		});

		this.client.on('message', (topic, message) => {
			if (topic === `${this.mqttTopic}/response`) {
				const data = JSON.parse(message.toString());
				if (data.macAddress === this.macAddress) {
					if (data.type === 'temperature') {
						this.cachedTemperature = data.value;
						this.lastUpdated = Date.now();
					} else if (data.type === 'set') {
						this.log('Set command acknowledged');
					}
				}
			}
		});

		this.service = new Service.Thermostat(this.name);

		this.service.getCharacteristic(Characteristic.TargetTemperature)
			.setProps({
				minValue: 4.5,
				maxValue: 29.5,
				minStep: 0.5
			});

		setInterval(() => {
			this.updateCache();
		}, this.cacheDuration);
	}

	updateCache() {
		this.getCurrentTemperature((error, temperature) => {
			if (!error) {
				this.cachedTemperature = temperature;
				this.lastUpdated = Date.now();
			}
		});
	}

	isCacheValid() {
		return (Date.now() - this.lastUpdated) <= this.cacheDuration;
	}

	canSendRequest() {
		return (Date.now() - this.lastRequestTime) >= this.requestCooldown;
	}

	getServices() {
		const informationService = new Service.AccessoryInformation();
		informationService
			.setCharacteristic(Characteristic.Manufacturer, 'EQ3')
			.setCharacteristic(Characteristic.Model, 'Bluetooth Thermostat')
			.setCharacteristic(Characteristic.SerialNumber, this.macAddress)
			.setCharacteristic(Characteristic.FirmwareRevision, `${this.cacheDuration / 1000} seconds`);

		this.service.getCharacteristic(Characteristic.CurrentTemperature)
			.on('get', this.getCurrentTemperature.bind(this));

		this.service.getCharacteristic(Characteristic.TargetTemperature)
			.on('get', this.getTargetTemperature.bind(this))
			.on('set', this.setTargetTemperature.bind(this));

		this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
			.on('get', this.getCurrentHeatingCoolingState.bind(this));

		this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
			.on('get', this.getTargetHeatingCoolingState.bind(this))
			.on('set', this.setTargetHeatingCoolingState.bind(this));

		return [informationService, this.service];
	}

	getCurrentTemperature(callback) {
		if (this.isCacheValid()) {
			callback(null, this.cachedTemperature);
			return;
		}

		if (!this.canSendRequest()) {
			callback(null, this.cachedTemperature); // Return cached temperature if request cooldown is active
			return;
		}

		this.lastRequestTime = Date.now();
		this.client.publish(`${this.mqttTopic}/request`, JSON.stringify({
			type: 'getTemperature',
			macAddress: this.macAddress
		}));

		// Return cached temperature, MQTT response will update it in the background
		callback(null, this.cachedTemperature);
	}

	getTargetTemperature(callback) {
		this.getCurrentTemperature((error, temperature) => {
			if (error) {
				callback(error);
				return;
			}
			callback(null, temperature);
		});
	}

	setTargetTemperature(value, callback) {
		if (value < 4.5) value = 4.5;
		if (value > 29.5) value = 29.5;

		this.client.publish(`${this.mqttTopic}/request`, JSON.stringify({
			type: 'setTemperature',
			macAddress: this.macAddress,
			value: value
		}));

		this.cachedTemperature = value; // Optimistically update cached temperature
		callback(null);
	}

	getCurrentHeatingCoolingState(callback) {
		this.getCurrentTemperature((error, temperature) => {
			if (error) {
				callback(error);
				return;
			}

			if (temperature === 4.5) {
				callback(null, Characteristic.CurrentHeatingCoolingState.OFF);
			} else {
				callback(null, Characteristic.CurrentHeatingCoolingState.HEAT);
			}
		});
	}

	getTargetHeatingCoolingState(callback) {
		this.getCurrentTemperature((error, temperature) => {
			if (error) {
				callback(error);
				return;
			}

			if (temperature === 4.5) {
				callback(null, Characteristic.TargetHeatingCoolingState.OFF);
			} else {
				callback(null, Characteristic.TargetHeatingCoolingState.HEAT);
			}
		});
	}

	setTargetHeatingCoolingState(value, callback) {
		let modeCommand;
		switch (value) {
			case Characteristic.TargetHeatingCoolingState.OFF:
				modeCommand = 'off';
				break;
			case Characteristic.TargetHeatingCoolingState.HEAT:
			case Characteristic.TargetHeatingCoolingState.COOL:
				modeCommand = 'manual';
				break;
			case Characteristic.TargetHeatingCoolingState.AUTO:
				modeCommand = 'auto';
				break;
		}

		this.client.publish(`${this.mqttTopic}/request`, JSON.stringify({
			type: 'setMode',
			macAddress: this.macAddress,
			mode: modeCommand
		}));

		callback(null);
	}
}
