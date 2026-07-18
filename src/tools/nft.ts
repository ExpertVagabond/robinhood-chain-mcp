import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, fromHex, json } from "../rpc.js";
import { BlockscoutClient } from "../blockscout.js";
import { decodeAbiParameters, parseAbiParameters } from "viem";

const pad = (v: string) => v.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const padNum = (v: string | bigint) => BigInt(v).toString(16).padStart(64, "0");
const call = (rpc: RpcClient, to: string, data: string) =>
  rpc.call<string>("eth_call", [{ to, data }, "latest"]);

function decodeString(hex: string): string | null {
  try {
    return decodeAbiParameters(parseAbiParameters("string"), hex as `0x${string}`)[0] as string;
  } catch {
    return null;
  }
}

export function registerNftTools(
  register: Register,
  rpc: RpcClient,
  scout: BlockscoutClient,
) {
  register(
    "nft_owner",
    "ERC-721 ownerOf for a token ID.",
    { contract: z.string(), tokenId: z.string() },
    async ({ contract, tokenId }) => {
      // ownerOf(uint256)
      const raw = await call(rpc, contract, "0x6352211e" + padNum(tokenId));
      return json({ contract, tokenId, owner: "0x" + raw.slice(-40) });
    },
  );

  register(
    "nft_token_uri",
    "ERC-721 tokenURI, with inline data: URIs decoded when present.",
    { contract: z.string(), tokenId: z.string() },
    async ({ contract, tokenId }) => {
      // tokenURI(uint256)
      const raw = await call(rpc, contract, "0xc87b56dd" + padNum(tokenId));
      const uri = decodeString(raw);
      let inline: unknown = null;
      if (uri?.startsWith("data:application/json;base64,")) {
        try {
          inline = JSON.parse(
            Buffer.from(uri.split(",")[1] ?? "", "base64").toString("utf8"),
          );
        } catch {
          inline = null;
        }
      }
      return json({ contract, tokenId, tokenURI: uri, inlineMetadata: inline });
    },
  );

  register(
    "nft_balance",
    "ERC-721 balanceOf — how many NFTs from a collection an address holds.",
    { contract: z.string(), owner: z.string() },
    async ({ contract, owner }) => {
      const raw = await call(rpc, contract, "0x70a08231" + pad(owner));
      return json({ contract, owner, balance: fromHex(raw).toString() });
    },
  );

  register(
    "nft_collection_info",
    "ERC-721 collection name, symbol, and total supply where exposed.",
    { contract: z.string() },
    async ({ contract }) => {
      const [name, symbol, supply] = await Promise.all([
        call(rpc, contract, "0x06fdde03").catch(() => null),
        call(rpc, contract, "0x95d89b41").catch(() => null),
        call(rpc, contract, "0x18160ddd").catch(() => null),
      ]);
      return json({
        contract,
        name: name ? decodeString(name) : null,
        symbol: symbol ? decodeString(symbol) : null,
        totalSupply: supply ? fromHex(supply).toString() : null,
      });
    },
  );

  register(
    "erc1155_balance",
    "ERC-1155 balanceOf for an (account, id) pair.",
    { contract: z.string(), account: z.string(), tokenId: z.string() },
    async ({ contract, account, tokenId }) => {
      // balanceOf(address,uint256)
      const raw = await call(rpc, contract, "0x00fdd58e" + pad(account) + padNum(tokenId));
      return json({ contract, account, tokenId, balance: fromHex(raw).toString() });
    },
  );

  register(
    "detect_token_standard",
    "Detect whether a contract is ERC-20, ERC-721, or ERC-1155, using ERC-165 supportsInterface with an ERC-20 fallback.",
    { contract: z.string() },
    async ({ contract }) => {
      const supports = async (interfaceId: string) => {
        try {
          const raw = await call(
            rpc,
            contract,
            "0x01ffc9a7" + interfaceId.replace(/^0x/, "").padEnd(64, "0"),
          );
          return fromHex(raw) === 1n;
        } catch {
          return false;
        }
      };
      const [erc721, erc1155, erc165] = await Promise.all([
        supports("0x80ac58cd"),
        supports("0xd9b67a26"),
        supports("0x01ffc9a7"),
      ]);
      // ERC-20 predates ERC-165, so infer it from the presence of decimals().
      let erc20 = false;
      if (!erc721 && !erc1155) {
        erc20 = await call(rpc, contract, "0x313ce567")
          .then(() => true)
          .catch(() => false);
      }
      return json({
        contract,
        erc165: erc165,
        erc721,
        erc1155,
        erc20,
        standard: erc721 ? "ERC-721" : erc1155 ? "ERC-1155" : erc20 ? "ERC-20" : "unknown",
        note: "ERC-20 has no ERC-165 interface ID; presence of decimals() is used as the signal.",
      });
    },
  );

  register(
    "address_nfts",
    "NFTs held by an address, via the explorer index. Mainnet only.",
    { address: z.string(), limit: z.number().default(20) },
    async ({ address, limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>(
        `/addresses/${address}/nft`,
        { type: "ERC-721,ERC-1155" },
      );
      const items = (res.items ?? []).slice(0, limit);
      return json({
        address,
        count: items.length,
        nfts: items.map((n) => ({
          tokenId: n.id,
          type: n.token_type,
          contract: (n.token as Record<string, unknown>)?.address_hash ?? null,
          name: (n.token as Record<string, unknown>)?.name ?? null,
          metadata: n.metadata ?? null,
        })),
      });
    },
  );
}
