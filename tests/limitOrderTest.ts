import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";

import { expect } from "chai";

describe("limit_order - initialize", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.limitOrder as anchor.Program;

  const wallet = provider.wallet;
  let globalConfigPda: PublicKey;

  it("initializes the global config", async () => {
    // Derive global_config PDA
    [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    const platformFee = 50;
    const treasury = wallet.publicKey;

    const listener = await program.addEventListener(
      "Initialized",
      (event: any, slot) => {
        try {
          expect(event.owner.toBase58()).to.equal(wallet.publicKey.toBase58());
          expect(event.platform_fee.toNumber()).to.equal(platformFee);
          expect(event.treasury.toBase58()).to.equal(
            wallet.publicKey.toBase58()
          );
          expect(event.paused()).to.equal(false);
        } catch (e) {
          console.error("Event assertion failed:", e);
          throw e;
        }
      }
    );

    await program.methods
      .initialize(platformFee, treasury)
      .accounts({
        global_config: globalConfigPda,
        signer: wallet.publicKey,
        system_program: SystemProgram.programId,
      })
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 500));
    await program.removeEventListener(listener);

    const config = await program.account["globalConfig"].fetch(globalConfigPda);

    expect(config.owner.toBase58()).to.equal(wallet.publicKey.toBase58());
    expect(config.platformFee).to.equal(platformFee);
    expect(config.treasury.toBase58()).to.equal(wallet.publicKey.toBase58());
    expect(config.paused).to.equal(false);
  });
});

describe("limit_order open_order_spl test", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.limitOrder as anchor.Program;
  const user = provider.wallet.publicKey;

  it("should open a SPL-token limit order", async () => {
    // 1. 创建一个测试 SPL Token mint
    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      user,
      null,
      6 // decimals
    );

    // 2. 获取用户的 ATA
    const userTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      user
    );

    // 3. 给用户 mint 一些测试 token
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      userTokenAccount.address,
      user,
      1000_000_000
    );

    // 4. 计算 order PDA和 order ATA
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [orderPda, bump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("limit_order"),
        user.toBuffer(),
        expiry.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const ataAddress = anchor.utils.token.associatedAddress({
      mint,
      owner: orderPda,
    });

    // 5. 构造 open order 参数
    const openOrderParams = {
      fromToken: mint,
      fromChainId: new anchor.BN(10002),
      amountIn: new anchor.BN(1_000_000),
      toChainId: new anchor.BN(2),

      toToken: (() => {
        const arr = new Uint8Array(40);
        const strBytes = Buffer.from("satoxi");
        arr.set(strBytes.slice(0, 40));
        return arr;
      })(),

      recipient: (() => {
        const arr = new Uint8Array(40);
        arr.set(user.toBytes().slice(0, 40));
        return arr;
      })(),
      expiry: expiry,
      amountOut: new Uint8Array(32),
    };

    // 6. 添加事件监听器
    const listener = await program.addEventListener(
      "OrderOpened",
      (event: any, slot) => {
        try {
          expect(event.orderPubkey.toBase58()).to.equal(orderPda.toBase58());
        } catch (e) {
          console.error("Event assertion failed:", e);
          throw e;
        }
      }
    );
    // 7. 调用 open_order
    await program.methods
      .openOrderSpl(openOrderParams)
      .accounts({
        order: orderPda,
        user: user,
        userTokenAccount: userTokenAccount.address,
        orderTokenAccount: ataAddress,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .rpc();

    // 8. 等待事件处理
    await new Promise((resolve) => setTimeout(resolve, 500));
    await program.removeEventListener(listener);

    // 9. 查询 order 账户，检查存储
    const orderAccount = await program.account["limitOrder"].fetch(orderPda);

    // 10. 验证数据存储
    expect(orderAccount.amountIn.eq(openOrderParams.amountIn)).to.be.true;
    expect(orderAccount.fromToken.equals(openOrderParams.fromToken)).to.be.true;
    expect(orderAccount.fromChainId.eq(openOrderParams.fromChainId)).to.be.true;
    expect(orderAccount.toChainId.eq(openOrderParams.toChainId)).to.be.true;

    expect(
      Buffer.from(orderAccount.toToken).equals(
        Buffer.from(openOrderParams.toToken)
      )
    ).to.be.true;

    expect(
      Buffer.from(orderAccount.recipient).equals(
        Buffer.from(openOrderParams.recipient)
      )
    ).to.be.true;

    expect(orderAccount.expiry.eq(openOrderParams.expiry)).to.be.true;

    expect(
      Buffer.from(orderAccount.amountOut).equals(
        Buffer.from(openOrderParams.amountOut)
      )
    ).to.be.true;

    expect(orderAccount.sender.equals(user)).to.be.true;

    expect(orderAccount.bump).to.equal(bump);

    //11. 验证spl token是否到账

    const orderTokenAccountInfo = await getAccount(
      provider.connection,
      ataAddress
    );
    expect(orderTokenAccountInfo.amount).to.equal(
      BigInt(openOrderParams.amountIn.toString())
    );
  });
});

describe("limit_order open_order_spl test", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.limitOrder as anchor.Program;
  const user = provider.wallet.publicKey;
  it("should open a SOL limit order", async () => {
    // 构造 order PDA
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [orderPda, bump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("limit_order"),
        user.toBuffer(),
        expiry.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const amountInLamports = new anchor.BN(1_000_000); // 0.001 SOL
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
        arr.set(user.toBytes().slice(0, 40));
        return arr;
      })(),
      expiry: expiry,
      amountOut: new Uint8Array(32),
    };

    // 事件监听器
    const listener = await program.addEventListener(
      "OrderOpened",
      (event: any) => {
        expect(event.orderPubkey.toBase58()).to.equal(orderPda.toBase58());
      }
    );

    // 执行 open_order_sol
    await program.methods
      .openOrderSol(openOrderParams)
      .accounts({
        order: orderPda,
        user: user,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // 等待事件
    await new Promise((res) => setTimeout(res, 500));
    await program.removeEventListener(listener);

    // 获取订单账户
    const orderAccount = await program.account["limitOrder"].fetch(orderPda);

    // 数据断言
    expect(orderAccount.fromToken.toBase58()).to.equal(
      openOrderParams.fromToken.toBase58()
    );
    expect(orderAccount.fromChainId.toString()).to.equal(
      openOrderParams.fromChainId.toString()
    );
    expect(orderAccount.amountIn.toString()).to.equal(
      openOrderParams.amountIn.toString()
    );
    expect(orderAccount.toChainId.toString()).to.equal(
      openOrderParams.toChainId.toString()
    );
    expect(Buffer.from(orderAccount.toToken)).to.eql(
      Buffer.from(openOrderParams.toToken)
    );
    expect(Buffer.from(orderAccount.recipient)).to.eql(
      Buffer.from(openOrderParams.recipient)
    );
    expect(orderAccount.expiry.toString()).to.equal(
      openOrderParams.expiry.toString()
    );
    expect(Buffer.from(orderAccount.amountOut)).to.eql(
      Buffer.from(openOrderParams.amountOut)
    );
    expect(orderAccount.sender.toBase58()).to.equal(user.toBase58());
    expect(orderAccount.bump).to.equal(bump);

    // 检查 PDA 中 lamports 是否到账
    const accountInfo = await provider.connection.getAccountInfo(orderPda);
    const rentExempt =
      await provider.connection.getMinimumBalanceForRentExemption(
        8 + 32 + 8 + 8 + 8 + 40 + 40 + 32 + 8 + 32 + 8 + 1
      );
    const actualDeposit = accountInfo.lamports - rentExempt;

    expect(actualDeposit).to.equal(openOrderParams.amountIn.toNumber());
  });
});
