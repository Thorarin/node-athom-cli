'use strict';

const os = require('os');
const config = require('../../config.js');
const Log = require('../..').Log;
const Settings = require('../..').Settings;
const AthomCloudAPI = require('athom-api').AthomCloudAPI;
const inquirer = require('inquirer');
const colors = require('colors');
const _ = require('underscore');
const fetch = require('node-fetch');

class AthomApi {
	
	constructor() {
		this._api = null;
		this._user = null;
		this._homeys = null;
		this._activeHomey = null;

		this._store = {
			get: async function() {
				return await Settings.get('_athom_api_state') || {};
			},
			set: async function(value) {
				return await Settings.set('_athom_api_state', value);
			}
		}
	}
	
	async _initApi() {
		if( this._api ) return this._api;
		
		let token = await Settings.get('athomToken');
				
		this._api = new AthomCloudAPI({
			clientId: config.athomApiClientId,
			clientSecret: config.athomApiClientSecret,
			store: this._store
		});

		if(token) {
			await this._api.setToken(token);
			await Settings.unset('athomToken');
		}

		if( ! await this._api.isLoggedIn() )
			await this.login();
	}
	
	async login() {
		Log(colors.bold('To log in with your Athom Account, please visit', colors.underline.cyan(config.athomApiLoginUrl)));
		let answers = await inquirer.prompt([
			{
				'type': 'input',
				'name': 'token',
				'message': 'Paste the Account Token:',
			}	
		]);
		
		try {
			let token = answers.token;
				token = new Buffer(token, 'base64').toString();
				token = JSON.parse(token);

			await this._initApi();
			await this._api.setToken(token);

			let profile = await this.getProfile();
			
			Log(colors.green(`✓ You are now logged in as ${profile.firstname} ${profile.lastname}`));
			
			return token;
		} catch( err ) {
			Log(colors.red('Invalid Account Token, please try again:'+err.stack));
		}
	}
	
	async logout() {
		Log(colors.green('✓ You are now logged out'));
		await this._initApi();
		await this._api.logout();
		await this.unsetActiveHomey();
	}
	
	async getProfile() {
		await this._initApi();
		try {
			return await this._api.getAuthenticatedUser();
		} catch(e) {
			return await this._api.getAuthenticatedUserCached();
		}
	}
	
	async getHomey( homeyId, { cache = false } = {}) {
		let homeys = await this.getHomeys();
		for( let i = 0; i < homeys.length; i++ ) {
			let homey = homeys[i];
			if( homey._id === homeyId ) return homey;
		}
		throw new Error('Invalid Homey');
	}
	
	async getHomeys({
		cache = true,
		local = true,
	} = {}) {
		if( cache && this._homeys ) return this._homeys;
		
		await this._initApi();
		
		this._user = this._user || await this.getProfile();
		this._homeys = await this._user.getHomeys();
		
		// find USB connected Homeys
		if( local ) {
			let ifaces = os.networkInterfaces();
			let candidates = [];
		
			for( let ifaceId in ifaces ) {
				let adapters = ifaces[ifaceId];
				for( let i = 0; i < adapters.length; i++ ) {
					let adapter = adapters[i];
					try {
						let ip = adapter.address.split('.');
						if( ip[0] !== '10' ) continue;
							ip[3] = '1';
							ip = ip.join('.');
						
						let res = await fetch(`http://${ip}/api/manager/webserver/ping`, {
							timeout: 1000,
						})
						if( !res.ok ) continue;
						
						let homeyId = res.headers.get('x-homey-id');
						if( !homeyId ) continue;
													
						let homey = _.findWhere(this._homeys, { id: homeyId })
						if( homey ) {
							homey.usb = ip;
						}
							
					} catch( err ) {}
						
				}
			}
		}
		
		return this._homeys;
	}
	
	async getActiveHomey() {
		if( this._activeHomey ) return this._activeHomey;
		
		let activeHomey = await Settings.get('activeHomey');
		if( activeHomey === null ) {
			activeHomey = await this.selectActiveHomey();
		}
		let homey = await this.getHomey( activeHomey.id );
		let homeyApi = await homey.authenticate()
		
		if( homey.name )
			homeyApi.name = homey.name;
			
		if( homey.usb ) {
			homeyApi.baseUrl = Promise.resolve(`http://${homey.usb}:80`);
		} else {
			homeyApi.baseUrl = Promise.resolve(homey.localUrl);
		}
		
		this._activeHomey = homeyApi;
		
		return this._activeHomey;
	}
	
	async setActiveHomey({ id, name }) {
		return Settings.set('activeHomey', { id, name });
	}
	
	async unsetActiveHomey() {
		return Settings.unset('activeHomey');		
	}
	
	async selectActiveHomey({
		id,
		name,
		filter = {
			online: true,
			local: true,
		}
	} = {}) {
		let homeys = await this.getHomeys();
		let activeHomey;
		
		if( typeof id === 'string' ) {
			activeHomey = _.findWhere(homeys, { _id: id });
		} else if( typeof name === 'string' ) {
			activeHomey = _.findWhere(homeys, { name });
		} else {			
			let answers = await inquirer.prompt([
				{
					type: 'list',
					name: 'homey',
					message: 'Choose an active Homey:',
					choices: homeys
						.filter(homey => {
							if( filter.online && homey.state && homey.state.indexOf('online') !== 0 ) return false;
							return true;
						})
						.map(homey => {
							let state = this.getFormattedState( homey );
							return {
								value: {
									name: homey.name,
									id: homey._id,
								},
								name: homey.name + ( state ? ` (${state})` : '' )
							}
						})
				}
			]);
			
			activeHomey = answers.homey;
		}
		
		if( !activeHomey )
			throw new Error('No Homey found');
				
		let result = await this.setActiveHomey( activeHomey );
		
		Log(`You have selected \`${activeHomey.name}\` as your active Homey.`);
		
		return result;
	}
	
	async unselectActiveHomey() {
		await this.unsetActiveHomey();
		Log(`You have unselected your active Homey.`);
	}
	
	getFormattedState( homey ) {			
		let state = homey.state || '';
			state = state.split('_')[0];
		if( state === 'online' ) state = colors.green(state);
		if( state === 'offline' ) state = colors.red(state);
		if( state === 'rebooting' ) state = colors.yellow(state);
		if( state === 'updating' ) state = colors.magenta(state);
			
		return state;
	}
}

module.exports = AthomApi;