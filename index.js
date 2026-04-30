const mqtt = require('mqtt');

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
		this.cacheDuration = (config.cacheDuration || 10) * 1000;
		this.requestCooldown = 5 * 1000;
		this.lastRequestTime = 0;
		this.cachedTemperature = 20.0;
		this.pendingSetUntil = 0;
		this.pendingSetGraceMs = 30 * 1000;
		this.client = mqtt.connect(this.mqttUrl);

		this.client.on('connect', () => {
			this.log('MQTT connected');
			this.client.subscribe(`${this.mqttTopic}/response`);
		});

		this.client.on('message', (topic, message) => {
			if (topic !== `${this.mqttTopic}/response`) return;
			let data;
			try {
				data = JSON.parse(message.toString());
			} catch (e) {
				this.log('Invalid MQTT message received');
				return;
			}
			if (data.macAddress === this.macAddress) {
				if (data.type === 'temperature') {
					if (Date.now() < this.pendingSetUntil) {
						this.log(`Ignoring polling response (${data.value}°C) — within set grace period`);
						return;
					}
					this.cachedTemperature = data.value;
					this.lastUpdated = Date.now();
				} else if (data.type === 'set') {
					this.log('Set command acknowledged');
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

	async updateCache() {
		if (!this.canSendRequest()) return;
		this.lastRequestTime = Date.now();
		this.client.publish(`${this.mqttTopic}/request`, JSON.stringify({
			type: 'getTemperature',
			macAddress: this.macAddress
		}));
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
			.onGet(this.getCurrentTemperature.bind(this));

		this.service.getCharacteristic(Characteristic.TargetTemperature)
			.onGet(this.getTargetTemperature.bind(this))
			.onSet(this.setTargetTemperature.bind(this));

		this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
			.onGet(this.getCurrentHeatingCoolingState.bind(this));

		this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
			.onGet(this.getTargetHeatingCoolingState.bind(this))
			.onSet(this.setTargetHeatingCoolingState.bind(this));

		return [informationService, this.service];
	}

	async getCurrentTemperature() {
		if (this.isCacheValid()) {
			return this.cachedTemperature;
		}

		if (!this.canSendRequest()) {
			return this.cachedTemperature;
		}

		this.lastRequestTime = Date.now();
		this.client.publish(`${this.mqttTopic}/request`, JSON.stringify({
			type: 'getTemperature',
			macAddress: this.macAddress
		}));

		return this.cachedTemperature;
	}

	async getTargetTemperature() {
		return this.getCurrentTemperature();
	}

	async setTargetTemperature(value) {
		if (value < 4.5) value = 4.5;
		if (value > 29.5) value = 29.5;

		this.client.publish(`${this.mqttTopic}/request`, JSON.stringify({
			type: 'setTemperature',
			macAddress: this.macAddress,
			value: value
		}));

		this.cachedTemperature = value;
		this.pendingSetUntil = Date.now() + this.pendingSetGraceMs;
	}

	async getCurrentHeatingCoolingState() {
		const temperature = await this.getCurrentTemperature();
		return temperature === 4.5
			? Characteristic.CurrentHeatingCoolingState.OFF
			: Characteristic.CurrentHeatingCoolingState.HEAT;
	}

	async getTargetHeatingCoolingState() {
		const temperature = await this.getCurrentTemperature();
		return temperature === 4.5
			? Characteristic.TargetHeatingCoolingState.OFF
			: Characteristic.TargetHeatingCoolingState.HEAT;
	}

	async setTargetHeatingCoolingState(value) {
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
			default:
				return;
		}

		this.client.publish(`${this.mqttTopic}/request`, JSON.stringify({
			type: 'setMode',
			macAddress: this.macAddress,
			mode: modeCommand
		}));
	}
}
