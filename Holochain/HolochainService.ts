import { AdminWebsocket, AgentPubKey, AppSignalCb, AppWebsocket, CapSecret, AppSignal } from '@holochain/conductor-api'
import low from 'lowdb'
import FileSync from 'lowdb/adapters/FileSync'
import path from 'path'
import fs from 'fs'
import HolochainLanguageDelegate from "./HolochainLanguageDelegate"
import {runSandbox, readSandboxes, createSandbox, stopProcesses, unpackDna, packDna} from "./hc-execution"
import type Dna from "./dna"
import type { ChildProcess } from 'child_process'

export const fakeCapSecret = (): CapSecret => Buffer.from(Array(64).fill('aa').join(''), 'hex')

export default class HolochainService {
    #db: any
    #adminPort: number
    #appPort: number
    #adminWebsocket: AdminWebsocket
    #appWebsocket: AppWebsocket
    #dataPath: string
    #ready: Promise<void>
    #sbPath: string
    #hcProcess: ChildProcess
    #lairProcess: ChildProcess
    #resourcePath: string
    //Map{dnaHashBuffer: [callbackFn, langHash]}
    signalCallbacks: Map<string, [AppSignalCb, string]>;

    constructor(sandboxPath, dataPath, resourcePath) {
        let resolveReady
        this.#ready = new Promise(resolve => resolveReady = resolve)

        console.log("HolochainService: Creating low-db instance for holochain-serivce");
        this.#dataPath = dataPath
        this.#db = low(new FileSync(path.join(dataPath, 'holochain-service.json')))
        this.#db.defaults({pubKeys: []}).write()
        this.signalCallbacks = new Map();

        const holochainAppPort = 1337;
        const holochainAdminPort = 2000;
        this.#resourcePath = resourcePath;

        console.log("HolochainService: attempting to read sandboxes");
        let sandboxes = readSandboxes(`${resourcePath}/hc`);
        console.log("HolochainService: found sandboxes", sandboxes);
        if (sandboxes.length == 0) {
            createSandbox(`${this.#resourcePath}/hc`, sandboxPath);
        };
        sandboxes = readSandboxes(`${this.#resourcePath}/hc`);
        console.log("HolochainService: Running with sanboxes:", sandboxes, "and using sandbox:", sandboxes[0]);
        this.#sbPath = sandboxes[0];

        runSandbox(`${this.#resourcePath}/lair-keystore`, `${this.#resourcePath}/hc`, `${this.#resourcePath}/holochain`, sandboxes[0], holochainAdminPort).then(async result => {
            console.log("HolochainService: Sandbox running... Attempting connection\n\n\n");
            [this.#hcProcess, this.#lairProcess] = result;
            try {
                this.#adminPort = holochainAdminPort;
                this.#appPort = holochainAppPort;
                if (this.#adminWebsocket == undefined) {
                    this.#adminWebsocket = await AdminWebsocket.connect(`ws://localhost:${this.#adminPort}`)
                    this.#adminWebsocket.attachAppInterface({ port: this.#appPort })
                    console.debug("HolochainService: Holochain admin interface connected on port", this.#adminPort);
                };
                if (this.#appWebsocket == undefined) {
                    //TODO: there might need to be a sleep here
                    this.#appWebsocket = await AppWebsocket.connect(`ws://localhost:${this.#appPort}`, 100000, this.handleCallback.bind(this))
                    console.debug("HolochainService: Holochain app interface connected on port", this.#appPort)
                };
                resolveReady()
            } catch(e) {
                console.error("HolochainService: Error intializing Holochain conductor:", e)
            }
        })
    }

    handleCallback(signal: AppSignal) {
        console.log("GOT CALLBACK FROM HC, checking against language callbacks", this.signalCallbacks);
        if (this.signalCallbacks.size != 0) {
            let callbacks = this.signalCallbacks.get(signal.data.cellId[1].toString("base64"))
            if (callbacks[0] != undefined) {
                callbacks[0](signal);
            };
        };
    }

    stop() {
        stopProcesses(this.#sbPath, this.#hcProcess, this.#lairProcess)
    }

    unpackDna(dnaPath: string): string {
        return unpackDna(`${this.#resourcePath}/hc`, dnaPath)
    }

    packDna(workdirPath: string): string {
        return packDna(`${this.#resourcePath}/hc`, workdirPath)
    }

    async pubKeyForLanguage(lang: string): Promise<AgentPubKey> {
        const alreadyExisting = this.#db.get('pubKeys').find({lang}).value()
        if(alreadyExisting) {
            const pubKey = Buffer.from(alreadyExisting.pubKey)
            console.debug("Found existing pubKey", pubKey.toString("base64"), "for language:", lang)
            return pubKey
        } else {
            const pubKey = await this.#adminWebsocket.generateAgentPubKey()
            this.#db.get('pubKeys').push({lang, pubKey}).write()
            console.debug("Created new pubKey", pubKey.toString("base64"), "for language", lang)
            return pubKey
        }
    }

    async ensureInstallDNAforLanguage(lang: string, dnas: Dna[], callback: AppSignalCb | undefined) {
        await this.#ready
        const pubKey = await this.pubKeyForLanguage(lang);
        if (callback != undefined) {
            console.log("HolochainService: setting holochains signal callback for language", lang);
            this.signalCallbacks.set(pubKey.toString("base64"), [callback, lang]);
        };

        const activeApps = await this.#adminWebsocket.listActiveApps();
        //console.log("HolochainService: Found running apps:", activeApps);
        if(!activeApps.includes(lang)) {

            let installed
            // 1. install app
            try {
                console.debug("HolochainService: Installing DNAs for language", lang)
                // console.debug(dnaFile)
                // let installedCellIds = await this.#adminWebsocket.listCellIds()
                // console.debug("HolochainService: Installed cells before:", installedCellIds)
                // const cellId = HolochainService.dnaID(lang, nick)

                for (let dna of dnas) {
                    //console.log("HolochainService: Installing DNA:", dna, "at data path:", this.#dataPath, "\n");
                    const p = path.join(this.#dataPath, `${lang}-${dna.nick}.dna`);
                    fs.writeFileSync(p, dna.file);
                    const hash = await this.#adminWebsocket.registerDna({
                        path: p
                    })
                    await this.#adminWebsocket.installApp({
                        installed_app_id: lang, agent_key: pubKey, dnas: [{hash: hash, nick: dna.nick}]
                    })
                }
                installed = true
            } catch(e) {
                // if(!e.data?.data?.indexOf('AppAlreadyInstalled')) {
                //     console.error("Error during install of DNA:", e)
                //     installed = false
                // } else {
                console.error(e);
                installed = false
            }

            if(!installed)
                return

            // 2. activate app
            try {
                await this.#adminWebsocket.activateApp({installed_app_id: lang})
            } catch(e) {
                console.error("HolochainService: ERROR activating app", lang, " - ", e)
            }
        }
    }

    getDelegateForLanguage(languageHash: string) {
        return new HolochainLanguageDelegate(languageHash, this)
    }

    static dnaID(languageHash: string, dnaNick: string) {
        return `${languageHash}-${dnaNick}`
    }

    async callZomeFunction(lang: string, dnaNick: string, zomeName: string, fnName: string, payload: object): Promise<any> {
        await this.#ready
        const installed_app_id = lang
        //console.debug("HolochainService.callZomefunction: getting info for app:", installed_app_id)
        let infoResult = await this.#appWebsocket.appInfo({installed_app_id})
        let tries = 1
        while(!infoResult && tries < 10) {
            await sleep(500)
            infoResult = await this.#appWebsocket.appInfo({installed_app_id})
            tries++
        }

        if(!infoResult) {
            console.error("HolochainService: no installed hApp found during callZomeFunction() for Language:", lang)
            console.error("Did the Language forget to register a DNA?")
            throw new Error("No DNA installed")
        }

        //console.debug("HolochainService.callZomefunction: get info result:", infoResult)
        const { cell_data } = infoResult
        if(cell_data.length === 0) {
            console.error("HolochainService: tried to call zome function without any installed cell!")
            return null
        }

        const cell = cell_data.find(c => c.cell_nick === dnaNick)
        if(!cell) {
            const e = new Error(`No DNA with nick '${dnaNick}' found for language ${installed_app_id}`)
            console.error(e)
            return e
        }

        //console.debug("HolochainService: found cell", cell);
        const cell_id = cell.cell_id
        const [_dnaHash, provenance] = cell_id

        try {
            //console.debug("\x1b[31m", "HolochainService calling zome function:", dnaNick, zomeName, fnName, payload)
            const result = await this.#appWebsocket.callZome({
                cap: fakeCapSecret(),
                cell_id,
                zome_name: zomeName,
                fn_name: fnName,
                provenance,
                payload
            })
            console.debug("\x1b[32m", "HolochainService zome function result:", result)
            return result
        } catch(e) {
            console.error("\x1b[31m", "HolochainService: ERROR calling zome function:", e)
            return e
        }
    }
}

const sleep = (ms) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), ms));