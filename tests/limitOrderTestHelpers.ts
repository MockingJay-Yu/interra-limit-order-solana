import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

type OpenOrderParams = {
  fromToken: PublicKey;
  fromChainId: anchor.BN;
  amountIn: anchor.BN;
  toChainId: anchor.BN;
  toToken: Uint8Array;
  recipient: Uint8Array;
  expiry: anchor.BN;
  amountOut: Uint8Array;
};

export async function createSolOrder(
  program: anchor.Program,
  user: PublicKey,
  amountIn: anchor.BN,
  expiry: anchor.BN
): Promise<[PublicKey, OpenOrderParams, number]> {
  const [orderPda, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("limit_order"),
      user.toBuffer(),
      expiry.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  const params = {
    fromToken: new PublicKey("So11111111111111111111111111111111111111112"),
    fromChainId: new anchor.BN(10002),
    amountIn,
    toChainId: new anchor.BN(2),
    toToken: new Uint8Array(Buffer.from("satoxi".padEnd(32, "\0"))),
    recipient: (() => {
      const arr = new Uint8Array(32);
      arr.set(user.toBytes());
      return arr;
    })(),
    expiry,
    amountOut: new Uint8Array(32),
  };

  await program.methods
    .openOrderSol(params)
    .accounts({
      order: orderPda,
      user: user,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return [orderPda, params, bump];
}

export async function createSplOrder(
  program: anchor.Program,
  provider: anchor.AnchorProvider,
  user: PublicKey,
  mint: PublicKey,
  amount: anchor.BN,
  expiry: anchor.BN
): Promise<[PublicKey, PublicKey, OpenOrderParams, number]> {
  const [orderPda, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("limit_order"),
      user.toBuffer(),
      expiry.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    provider.wallet.payer,
    mint,
    user
  );

  const orderTokenAccount = anchor.utils.token.associatedAddress({
    mint,
    owner: orderPda,
  });

  const params = {
    fromToken: mint,
    fromChainId: new anchor.BN(10002),
    amountIn: amount,
    toChainId: new anchor.BN(2),
    toToken: new Uint8Array(Buffer.from("satoxi".padEnd(32, "\0"))),
    recipient: (() => {
      const arr = new Uint8Array(32);
      arr.set(user.toBytes()); // 自动填入前 32 字节，后续为 0
      return arr;
    })(),
    expiry,
    amountOut: new Uint8Array(32),
  };

  await program.methods
    .openOrderSpl(params)
    .accounts({
      order: orderPda,
      user,
      userTokenAccount: userTokenAccount.address,
      orderTokenAccount,
      tokenMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    })
    .rpc();

  return [orderPda, orderTokenAccount, params, bump];
}
