import { AdminWebsocket, AgentPubKey, AppWebsocket, CapSecret } from '@holochain/conductor-api'
import low from 'lowdb'
import FileSync from 'lowdb/adapters/FileSync'
import path from 'path'
import fs from 'fs'
import HolochainLanguageDelegate from "./HolochainLanguageDelegate"
import {runSandbox, readSandboxes, createSandbox} from "./hc-execution"
import type Dna from "./dna"

export const fakeCapSecret = (): CapSecret => Buffer.from(Array(64).fill('aa').join(''), 'hex')

export default class HolochainService {
    #db: any
    #adminPort: number
    #appPort: number
    #adminWebsocket: AdminWebsocket
    #appWebsocket: AppWebsocket
    #dataPath: string
    #ready: Promise<void>

    constructor(sandboxPath, dataPath, resourcePath) {
        let resolveReady
        this.#ready = new Promise(resolve => resolveReady = resolve)

        console.log("HolochainService: Creating low-db instance for holochain-serivce");
        this.#dataPath = dataPath
        this.#db = low(new FileSync(path.join(dataPath, 'holochain-service.json')))
        this.#db.defaults({pubKeys: []}).write()

        const holochainAppPort = 1337;
        const holochainAdminPort = 2000;

        console.log("HolochainService: attempting to read sandboxes");
        let sandboxes = readSandboxes(`${resourcePath}/hc`);
        console.log("HolochainService: found sandboxes", sandboxes);
        if (sandboxes.length == 0) {
            createSandbox(`${resourcePath}/hc`, sandboxPath);
        };
        sandboxes = readSandboxes(`${resourcePath}/hc`);
        console.log("HolochainService: Running with sanboxes:", sandboxes, "and using sandbox:", sandboxes[0]);

        runSandbox(`${resourcePath}/hc`, `${resourcePath}/holochain`, sandboxes[0], holochainAdminPort).then(async result => {
            console.log("HolochainService: Sandbox running... Attempting connection\n\n\n");
            try {
                this.#adminPort = holochainAdminPort;
                this.#adminWebsocket = await AdminWebsocket.connect(`ws://localhost:${this.#adminPort}`)

                console.debug("HolochainService: Holochain admin interface connected on port", this.#adminPort)
                this.#appPort = holochainAppPort;
                //this.#adminWebsocket.attachAppInterface({ port: this.#appPort })
                this.#appWebsocket = await AppWebsocket.connect(`ws://localhost:${this.#appPort}`)
                console.debug("HolochainService: Holochain app interface connected on port", this.#appPort)
                resolveReady()
            } catch(e) {
                console.error("HolochainService: Error intializing Holochain conductor:", e)
            }
        })
    }

    async pubKeyForLanguage(lang: string): Promise<AgentPubKey> {
        //lang = "static2";
        const alreadyExisting = this.#db.get('pubKeys').find({lang}).value()
        if(alreadyExisting) {
            console.debug("Found existing pubKey entry", alreadyExisting, "for language:", lang)
            const pubKey = Buffer.from(alreadyExisting.pubKey.data)
            console.debug("Found existing pubKey", pubKey, "for language:", lang)
            return pubKey
        } else {
            const pubKey = await this.#adminWebsocket.generateAgentPubKey()
            this.#db.get('pubKeys').push({lang, pubKey}).write()
            console.debug("Created new pubKey", pubKey, "for language", lang)
            return pubKey
        }
    }

    async ensureInstallDNAforLanguage(lang: string, dnas: Dna[]) {
        await this.#ready

        const activeApps = await this.#adminWebsocket.listActiveApps();
        console.log("HolochainService: Found running apps:", activeApps);
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
                    const pubKey = await this.pubKeyForLanguage(lang);
                    fs.writeFileSync(p, dna.file);
                    const hash = await this.#adminWebsocket.registerDna({
                        path: p
                    })
                    console.log("Installing DNA");
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
        console.debug("HolochainService.callZomefunction: getting info for app:", installed_app_id)
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

        console.debug("HolochainService.callZomefunction: get info result:", infoResult)
        const { cell_data } = infoResult
        if(cell_data.length === 0) {
            console.error("HolochainService: tried to call zome function without any installed cell!")
            return null
        }

        const cell = cell_data.find(c => c[1] === dnaNick)
        if(!cell) {
            const e = new Error(`No DNA with nick '${dnaNick}' found for language ${installed_app_id}`)
            console.error(e)
            return e
        }

        const cell_id = cell[0]
        const [_dnaHash, provenance] = cell_id

        try {
            console.debug("HolochainService calling zome function:", dnaNick, zomeName, fnName, payload)
            const result = await this.#appWebsocket.callZome({
                cap: fakeCapSecret(),
                cell_id,
                zome_name: zomeName,
                fn_name: fnName,
                provenance,
                payload
            })
            console.debug("HolochainService zome function result:", result)
            return result
        } catch(e) {
            console.error("HolochainService: ERROR calling zome function:", e)
            return e
        }
    }
}

const sleep = (ms) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), ms));