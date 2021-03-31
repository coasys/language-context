import type HolochainLanguageDelegate from "./Holochain/HolochainLanguageDelegate";
import type AgentService from "ad4m/AgentService";
import type SignaturesService from "ad4m/SignaturesService";

export default interface LanguageContext {
    agent: AgentService;
    IPFS: IPFSNode;
    signatures: SignaturesService;
    storageDirectory: string;
    customSettings: object;
    Holochain: HolochainLanguageDelegate | void;
}

export interface IPFSNode {
    add(data: object): Promise<object>
    cat(data: object): Promise<object>
}