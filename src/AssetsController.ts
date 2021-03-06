import 'isomorphic-fetch';
import BaseController, { BaseConfig, BaseState } from './BaseController';
import PreferencesController from './PreferencesController';
import NetworkController, { NetworkType } from './NetworkController';
import { Token } from './TokenRatesController';
import { AssetsContractController } from './AssetsContractController';
import { manageCollectibleImage } from './util';

const contractMap = require('eth-contract-metadata');
const { toChecksumAddress } = require('ethereumjs-util');
const Mutex = require('await-semaphore').Mutex;

/**
 * @type Collectible
 *
 * Collectible representation
 *
 * @property address - Hex address of a ERC721 contract
 * @property tokenId - The NFT identifier
 * @property name - Name associated with this tokenId and contract address
 * @property image - URI of custom NFT image associated with this tokenId
 */
export interface Collectible {
	address: string;
	tokenId: number;
	name: string;
	image: string;
}

/**
 * @type MappedContract
 *
 * Contract information representation that is found in contractMap
 *
 * @property name - Contract name
 * @property logo - Contract logo
 * @property address - Contract address
 * @property symbol - Contract symbol
 * @property decimals - Contract decimals
 * @property api - Contract api, in case of a collectible contract
 * @property collectibles_api - Contract API specific endpoint to get collectibles information, as custom information
 * @property owner_api - Contract API specific endpoint to get owner information, as quantity of assets owned
 * @property erc20 - Whether is ERC20 asset
 * @property erc721 - Whether is ERC721 asset
 */
export interface MappedContract {
	name: string;
	logo?: string;
	address: string;
	symbol?: string;
	decimals?: number;
	api?: string;
	collectibles_api?: string;
	owner_api?: string;
	erc20?: boolean;
	erc721?: boolean;
}

/**
 * @type CollectibleCustomInformation
 *
 * Collectible custom information
 *
 * @property name - Collectible custom name
 * @property image - Image custom image URI
 */
export interface CollectibleCustomInformation {
	name: string;
	image: string;
}

/**
 * @type AssetsConfig
 *
 * Assets controller configuration
 *
 * @property networkType - Network ID as per net_version
 * @property selectedAddress - Vault selected address
 */
export interface AssetsConfig extends BaseConfig {
	networkType: NetworkType;
	selectedAddress: string;
}

/**
 * @type AssetsState
 *
 * Assets controller state
 *
 * @property allTokens - Object containing tokens per account and network
 * @property allCollectibles - Object containing collectibles per account and network
 * @property collectibles - List of collectibles associated with the active vault
 * @property tokens - List of tokens associated with the active vault
 */
export interface AssetsState extends BaseState {
	allTokens: { [key: string]: { [key: string]: Token[] } };
	allCollectibles: { [key: string]: { [key: string]: Collectible[] } };
	collectibles: Collectible[];
	tokens: Token[];
}

/**
 * Controller that stores assets and exposes convenience methods
 */
export class AssetsController extends BaseController<AssetsConfig, AssetsState> {
	private mutex = new Mutex();
	/**
	 * Get collectible tokenURI API
	 *
	 * @param contractAddress - ERC721 asset contract address
	 * @param tokenId - ERC721 asset identifier
	 * @returns - Collectible tokenURI
	 */
	private async getCollectibleTokenURI(contract: MappedContract, tokenId: number): Promise<string> {
		if (contract.api && contract.collectibles_api) {
			return `${contract.api + contract.collectibles_api}${tokenId}`;
		}
		const assetsContract = this.context.AssetsContractController as AssetsContractController;
		const supportsMetadata = await assetsContract.contractSupportsMetadataInterface(contract.address);
		/* istanbul ignore if */
		if (!supportsMetadata) {
			return '';
		}
		const tokenURI = await assetsContract.getCollectibleTokenURI(contract.address, tokenId);
		return tokenURI;
	}

	/**
	 * Request NFT custom information, name and image url
	 *
	 * @param address - Hex address of the collectible contract
	 * @param tokenId - The NFT identifier
	 * @returns - Promise resolving to the current collectible name and image
	 */
	private async getCollectibleCustomInformation(
		address: string,
		tokenId: number
	): Promise<CollectibleCustomInformation> {
		if (address in contractMap && contractMap[address].erc721) {
			try {
				const contract = contractMap[address];
				contract.address = address;
				const tokenURI = await this.getCollectibleTokenURI(contract, tokenId);
				const response = await fetch(tokenURI);
				const json = await response.json();
				const imageParam = json.hasOwnProperty('image') ? 'image' : 'image_url';
				const collectibleImage = manageCollectibleImage(address, json[imageParam]);
				return { image: collectibleImage, name: json.name };
			} catch (error) {
				return { image: '', name: contractMap[address].name };
			}
		}
		/* istanbul ignore */
		return { name: '', image: '' };
	}

	/**
	 * Name of this controller used during composition
	 */
	name = 'AssetsController';

	/**
	 * List of required sibling controllers this controller needs to function
	 */
	requiredControllers = ['AssetsContractController', 'NetworkController', 'PreferencesController'];

	/**
	 * Creates a AssetsController instance
	 *
	 * @param config - Initial options used to configure this controller
	 * @param state - Initial state to set on this controller
	 */
	constructor(config?: Partial<BaseConfig>, state?: Partial<AssetsState>) {
		super(config, state);
		this.defaultConfig = {
			networkType: 'ropsten',
			selectedAddress: ''
		};
		this.defaultState = {
			allCollectibles: {},
			allTokens: {},
			collectibles: [],
			tokens: []
		};
		this.initialize();
	}

	/**
	 * Adds a token to the stored token list
	 *
	 * @param address - Hex address of the token contract
	 * @param symbol - Symbol of the token
	 * @param decimals - Number of decimals the token uses
	 * @returns - Current token list
	 */
	async addToken(address: string, symbol: string, decimals: number) {
		const releaseLock = await this.mutex.acquire();
		address = toChecksumAddress(address);
		const { allTokens, tokens } = this.state;
		const { networkType, selectedAddress } = this.config;
		const newEntry: Token = { address, symbol, decimals };
		const previousEntry = tokens.find((token) => token.address === address);
		if (previousEntry) {
			const previousIndex = tokens.indexOf(previousEntry);
			tokens[previousIndex] = newEntry;
		} else {
			tokens.push(newEntry);
		}
		const addressTokens = allTokens[selectedAddress];
		const newAddressTokens = { ...addressTokens, ...{ [networkType]: tokens } };
		const newAllTokens = { ...allTokens, ...{ [selectedAddress]: newAddressTokens } };
		const newTokens = [...tokens];
		this.update({ allTokens: newAllTokens, tokens: newTokens });
		releaseLock();
		return newTokens;
	}

	/**
	 * Adds a collectible to the stored collectible list
	 *
	 * @param address - Hex address of the collectible contract
	 * @param tokenId - The NFT identifier
	 * @returns - Promise resolving to the current collectible list
	 */
	async addCollectible(address: string, tokenId: number): Promise<Collectible[]> {
		const releaseLock = await this.mutex.acquire();
		address = toChecksumAddress(address);
		const { allCollectibles, collectibles } = this.state;
		const { networkType, selectedAddress } = this.config;
		const existingEntry = collectibles.find(
			(collectible) => collectible.address === address && collectible.tokenId === tokenId
		);
		if (existingEntry) {
			releaseLock();
			return collectibles;
		}
		const { name, image } = await this.getCollectibleCustomInformation(address, tokenId);
		const newEntry: Collectible = { address, tokenId, name, image };
		const newCollectibles = [...collectibles, newEntry];
		const addressCollectibles = allCollectibles[selectedAddress];
		const newAddressCollectibles = { ...addressCollectibles, ...{ [networkType]: newCollectibles } };
		const newAllCollectibles = { ...allCollectibles, ...{ [selectedAddress]: newAddressCollectibles } };
		this.update({ allCollectibles: newAllCollectibles, collectibles: newCollectibles });
		releaseLock();
		return newCollectibles;
	}

	/**
	 * Removes a token from the stored token list
	 *
	 * @param address - Hex address of the token contract
	 */
	removeToken(address: string) {
		address = toChecksumAddress(address);
		const { allTokens, tokens } = this.state;
		const { networkType, selectedAddress } = this.config;
		const newTokens = tokens.filter((token) => token.address !== address);
		const addressTokens = allTokens[selectedAddress];
		const newAddressTokens = { ...addressTokens, ...{ [networkType]: newTokens } };
		const newAllTokens = { ...allTokens, ...{ [selectedAddress]: newAddressTokens } };
		this.update({ allTokens: newAllTokens, tokens: newTokens });
	}

	/**
	 * Removes a collectible from the stored token list
	 *
	 * @param address - Hex address of the collectible contract
	 * @param tokenId - Token identifier of the collectible
	 */
	removeCollectible(address: string, tokenId: number) {
		address = toChecksumAddress(address);
		const { allCollectibles, collectibles } = this.state;
		const { networkType, selectedAddress } = this.config;
		const newCollectibles = collectibles.filter(
			(collectible) => !(collectible.address === address && collectible.tokenId === tokenId)
		);
		const addressCollectibles = allCollectibles[selectedAddress];
		const newAddressCollectibles = { ...addressCollectibles, ...{ [networkType]: newCollectibles } };
		const newAllCollectibles = { ...allCollectibles, ...{ [selectedAddress]: newAddressCollectibles } };
		this.update({ allCollectibles: newAllCollectibles, collectibles: newCollectibles });
	}

	/**
	 * Extension point called if and when this controller is composed
	 * with other controllers using a ComposableController
	 */
	onComposed() {
		super.onComposed();
		const preferences = this.context.PreferencesController as PreferencesController;
		const network = this.context.NetworkController as NetworkController;
		preferences.subscribe(({ selectedAddress }) => {
			const { allCollectibles, allTokens } = this.state;
			const { networkType } = this.config;
			this.configure({ selectedAddress });
			this.update({
				collectibles: (allCollectibles[selectedAddress] && allCollectibles[selectedAddress][networkType]) || [],
				tokens: (allTokens[selectedAddress] && allTokens[selectedAddress][networkType]) || []
			});
		});
		network.subscribe(({ provider }) => {
			const { allCollectibles, allTokens } = this.state;
			const { selectedAddress } = this.config;
			const networkType = provider.type;
			this.configure({ networkType });
			this.update({
				collectibles: (allCollectibles[selectedAddress] && allCollectibles[selectedAddress][networkType]) || [],
				tokens: (allTokens[selectedAddress] && allTokens[selectedAddress][networkType]) || []
			});
		});
	}
}

export default AssetsController;
