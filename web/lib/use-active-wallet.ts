"use client";

// The connected wallet, plus the two balances that matter on Somnia.
//
// Every trading surface wants the same three facts: who, how much gas, how
// much collateral. Gas (STT) and collateral (tUSDC) are SEPARATE tokens here,
// which is the trap worth centralising: a wallet full of tUSDC still cannot
// place an order, and that otherwise surfaces as an opaque revert.
import { useAccount, useBalance, useReadContract } from "wagmi";
import { formatUnits } from "viem";
import { COLLATERAL_ADDRESS, COLLATERAL_DECIMALS, somniaChain } from "./somnia";

const balanceOfAbi = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
] as const;

export type ActiveWallet = {
    address: `0x${string}` | undefined;
    isConnected: boolean;
    /** Wrong network — writes will fail until the user switches. */
    wrongChain: boolean;
    /** Native STT, for gas. */
    gas: { raw: bigint; formatted: string } | null;
    /** tUSDC, the collateral every Event Contract settles in. */
    collateral: { raw: bigint; formatted: string } | null;
    /** True when connected but holding no gas — the #1 cause of failed trades. */
    needsGas: boolean;
    refetchCollateral: () => void;
};

export function useActiveWallet(): ActiveWallet {
    const { address, isConnected, chainId } = useAccount();

    const gasQuery = useBalance({
        address,
        query: { enabled: Boolean(address), refetchInterval: 20_000 },
    });

    const collateralQuery = useReadContract({
        address: COLLATERAL_ADDRESS as `0x${string}`,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
        query: { enabled: Boolean(address), refetchInterval: 20_000 },
    });

    const gasRaw = gasQuery.data?.value;
    const collateralRaw = collateralQuery.data as bigint | undefined;

    return {
        address,
        isConnected,
        wrongChain: isConnected && chainId !== undefined && chainId !== somniaChain.id,
        gas:
            gasRaw === undefined
                ? null
                : { raw: gasRaw, formatted: Number(formatUnits(gasRaw, 18)).toFixed(4) },
        collateral:
            collateralRaw === undefined
                ? null
                : {
                    raw: collateralRaw,
                    formatted: Number(formatUnits(collateralRaw, COLLATERAL_DECIMALS)).toFixed(2),
                },
        needsGas: isConnected && gasRaw !== undefined && gasRaw === 0n,
        refetchCollateral: () => void collateralQuery.refetch(),
    };
}
