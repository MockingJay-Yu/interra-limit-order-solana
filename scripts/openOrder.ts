import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.limitOrder as anchor.Program;

  const wallet = provider.wallet;

  //   let globalConfigPda: PublicKey;

  //   [globalConfigPda] = PublicKey.findProgramAddressSync(
  //     [Buffer.from("global-config")],
  //     program.programId
  //   );
  //   console.log(globalConfigPda);
  //   const platformFee = 50;
  //   const treasury = wallet.publicKey;

  //   await program.methods
  //     .initialize(platformFee, treasury)
  //     .accounts({
  //       global_config: globalConfigPda,
  //       signer: wallet.publicKey,
  //       system_program: SystemProgram.programId,
  //     })
  //     .rpc();

  // 构造 order PDA
  const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

  const [orderPda, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("limit_order"),
      wallet.publicKey.toBuffer(),
      expiry.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  const amountInLamports = new anchor.BN(10_000_000); // 0.01 SOL
  const openOrderParams = {
    fromToken: new PublicKey("So11111111111111111111111111111111111111112"),
    fromChainId: new anchor.BN(10002),
    amountIn: amountInLamports,
    toChainId: new anchor.BN(2),
    toToken: (() => {
      const arr = new Uint8Array(40);
      const strBytes = Buffer.from("satoxi");
      arr.set(strBytes.slice(0, 40));
      return arr;
    })(),
    recipient: (() => {
      const arr = new Uint8Array(40);
      arr.set(wallet.publicKey.toBytes().slice(0, 40));
      return arr;
    })(),
    expiry: expiry,
    amountOut: new Uint8Array(32),
  };

  //   // 执行 open_order_sol
  //   await program.methods
  //     .openOrderSol(openOrderParams)
  //     .accounts({
  //       order: orderPda,
  //       user: wallet.publicKey,
  //       systemProgram: SystemProgram.programId,
  //     })
  //     .rpc();

  const orderAccount = await program.account["limitOrder"].fetch(
    "5MbqdZ6SrEzoHfFATUAnTLajexZxQCo8Uk32aYWYorgu"
  );
  console.log("Order PDA:", orderAccount);
}

main();
