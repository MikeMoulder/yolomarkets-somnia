import { createConfig, fallback, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { somniaChain, HTTP_RPC_URL } from "./somnia";

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// Somnia's public endpoints send CORS headers, so the same RPC list works in
// the browser and on the server. `dream-rpc` is a documented alias for the
// same network, kept as a fallback so one endpoint going down doesn't take
// the app with it.
const DEFAULT_RPC_URLS = [HTTP_RPC_URL, "https://dream-rpc.somnia.network"];

// NEXT_PUBLIC_* is inlined at build time, so this must stay a static reference.
const overrideRpcUrls = (process.env.NEXT_PUBLIC_SOMNIA_RPC_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

const rpcUrls = overrideRpcUrls.length ? overrideRpcUrls : DEFAULT_RPC_URLS;

export const wagmiConfig = createConfig({
    chains: [somniaChain],
    connectors: [
        injected({ shimDisconnect: true }),
        ...(walletConnectProjectId
            ? [
                walletConnect({
                    projectId: walletConnectProjectId,
                    showQrModal: true,
                    metadata: {
                        name: "YOLO Markets",
                        description: "Autonomous trading desk for DreamDEX Event Contracts on Somnia.",
                        url: appUrl,
                        icons: [`${appUrl}/icon.svg`],
                    },
                }),
            ]
            : []),
    ],
    transports: {
        [somniaChain.id]: fallback(rpcUrls.map((url) => http(url))),
    },
    ssr: true,
});

declare module "wagmi" {
    interface Register {
        config: typeof wagmiConfig;
    }
}
