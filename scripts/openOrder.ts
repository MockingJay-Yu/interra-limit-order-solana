import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
} from "@solana/spl-token";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.limitOrder as anchor.Program;

  const user = provider.wallet.publicKey;

  let globalConfigPda: PublicKey;

  [globalConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  );
  console.log(globalConfigPda);
  const orderPubkey = new PublicKey(
    "GyUAWrPgwrgSuQghZss1P66VfPyjMFfV6NWVEACy5Dfh"
  );
  const orderPda = await program.account["limitOrder"].fetch(orderPubkey);

  const tokenMint = orderPda.fromToken as PublicKey;
  const sender = orderPda.sender as PublicKey;

  const orderTokenAccount = anchor.utils.token.associatedAddress({
    mint: tokenMint,
    owner: orderPubkey,
  });

  const treasuryAta = await getAssociatedTokenAddress(
    tokenMint,
    user, // user is acting as treasury here
    false
  );

  const treasuryAtaInfo = await provider.connection.getAccountInfo(treasuryAta);
  if (!treasuryAtaInfo) {
    await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      tokenMint,
      user
    );
  }
  const receiver = anchor.web3.Keypair.generate();
  const targetTokenAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    provider.wallet.payer,
    tokenMint,
    receiver.publicKey
  );

  await program.methods
    .executeOrderSpl(new anchor.BN(0)) // SPL case
    .accounts({
      order: orderPubkey,
      orderTokenAccount: orderTokenAccount,
      targetTokenAccount: targetTokenAccount.address,
      treasuryTokenAccount: treasuryAta,
      globalConfig: globalConfigPda,
      refundReceiver: sender,
      executor: user,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  //   await program.methods
  //     .initialize(platformFee, treasury)
  //     .accounts({
  //       global_config: globalConfigPda,
  //       signer: wallet.publicKey,
  //       system_program: SystemProgram.programId,
  //     })
  //     .rpc();

  // 构造 order PDA
  // const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

  // const [orderPda, bump] = PublicKey.findProgramAddressSync(
  //   [
  //     Buffer.from("limit_order"),
  //     wallet.publicKey.toBuffer(),
  //     expiry.toArrayLike(Buffer, "le", 8),
  //   ],
  //   program.programId
  // );

  // const amountInLamports = new anchor.BN(10_000_000); // 0.01 SOL
  // const openOrderParams = {
  //   fromToken: new PublicKey("So11111111111111111111111111111111111111112"),
  //   fromChainId: new anchor.BN(10002),
  //   amountIn: amountInLamports,
  //   toChainId: new anchor.BN(2),
  //   toToken: (() => {
  //     const arr = new Uint8Array(40);
  //     const strBytes = Buffer.from("satoxi");
  //     arr.set(strBytes.slice(0, 40));
  //     return arr;
  //   })(),
  //   recipient: (() => {
  //     const arr = new Uint8Array(40);
  //     arr.set(wallet.publicKey.toBytes().slice(0, 40));
  //     return arr;
  //   })(),
  //   expiry: expiry,
  //   amountOut: new Uint8Array(32),
  // };

  //   // 执行 open_order_sol
  //   await program.methods
  //     .openOrderSol(openOrderParams)
  //     .accounts({
  //       order: orderPda,
  //       user: wallet.publicKey,
  //       systemProgram: SystemProgram.programId,
  //     })
  //     .rpc();
}

main();
