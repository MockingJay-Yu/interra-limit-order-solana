import * as anchor from "@coral-xyz/anchor";
import { AnchorError } from "@coral-xyz/anchor";

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
import { createSolOrder, createSplOrder } from "./limitOrderTestHelpers";
import { expect } from "chai";

describe("globalConfig test", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.limitOrder as anchor.Program;

  const user = provider.wallet.publicKey;
  let globalConfigPda: PublicKey;

  it("initializes the global config", async () => {
    // Derive global_config PDA
    [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );
    const platformFee = 30;

    const listener = await program.addEventListener(
      "Initialized",
      (event: any, slot) => {
        try {
          expect(event.owner.toBase58()).to.equal(user.toBase58());
          expect(event.platform_fee.toNumber()).to.equal(platformFee);
          expect(event.treasury.toBase58()).to.equal(user.toBase58());
          expect(event.paused()).to.equal(false);
        } catch (e) {
          console.error("Event assertion failed:", e);
          throw e;
        }
      }
    );

    await program.methods
      .initialize(platformFee, user)
      .accounts({
        global_config: globalConfigPda,
        signer: user,
        system_program: SystemProgram.programId,
      })
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 500));
    await program.removeEventListener(listener);

    const config = await program.account["globalConfig"].fetch(globalConfigPda);

    expect(config.owner.toBase58()).to.equal(user.toBase58());
    expect(config.platformFee).to.equal(platformFee);
    expect(config.treasury.toBase58()).to.equal(user.toBase58());
    expect(config.paused).to.equal(false);
  });

  it("should fail if non-owner tries to update global config", async () => {
    const nonOwner = anchor.web3.Keypair.generate();

    const airdropSignature = await provider.connection.requestAirdrop(
      nonOwner.publicKey,
      1_000_000_000 // 1 SOL
    );
    await provider.connection.confirmTransaction(airdropSignature);

    let caughtError = null;
    try {
      await program.methods
        .updateConfig(nonOwner.publicKey, 50, nonOwner.publicKey, false)
        .accounts({
          global_config: globalConfigPda,
          owner: nonOwner.publicKey,
        })
        .signers([nonOwner])
        .rpc();
    } catch (err) {
      caughtError = err;
    }
    const anchorError = caughtError as AnchorError;
    expect(anchorError.error.errorCode.code).to.equal("ConstraintHasOne");
  });

  it("should success if owner tries to update global config", async () => {
    const platformFee = 50;

    const listener = await program.addEventListener(
      "ConfigUpdated",
      (event: any, slot) => {
        try {
          expect(event.owner.toBase58()).to.equal(user.toBase58());
          expect(event.platform_fee.toNumber()).to.equal(platformFee);
          expect(event.treasury.toBase58()).to.equal(user.toBase58());
          expect(event.paused()).to.equal(false);
        } catch (e) {
          console.error("Event assertion failed:", e);
          throw e;
        }
      }
    );

    await program.methods
      .updateConfig(user, platformFee, user, false)
      .accounts({
        global_config: globalConfigPda,
        owner: user,
      })
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 500));
    await program.removeEventListener(listener);

    const config = await program.account["globalConfig"].fetch(globalConfigPda);

    expect(config.owner.toBase58()).to.equal(user.toBase58());
    expect(config.platformFee).to.equal(platformFee);
    expect(config.treasury.toBase58()).to.equal(user.toBase58());
    expect(config.paused).to.equal(false);
  });
});

describe("openOrder test", () => {
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

    // 4. 添加事件监听器
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

    // 5. 创建spl订单
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const amount = new anchor.BN(1_000_000);

    const [orderPda, orderTokenAccount, openOrderParams, bump] =
      await createSplOrder(program, provider, user, mint, amount, expiry);

    // 6. 等待事件处理
    await new Promise((resolve) => setTimeout(resolve, 500));
    await program.removeEventListener(listener);

    // 7. 查询 order 账户，检查存储
    const orderAccount = await program.account["limitOrder"].fetch(orderPda);

    // 8. 验证数据存储
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

    //9. 验证spl token是否到账

    const orderTokenAccountInfo = await getAccount(
      provider.connection,
      orderTokenAccount
    );
    expect(orderTokenAccountInfo.amount).to.equal(
      BigInt(openOrderParams.amountIn.toString())
    );
  });
  it("should open a SOL limit order", async () => {
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const amount = new anchor.BN(1_000_000);

    // 事件监听器
    const listener = await program.addEventListener(
      "OrderOpened",
      (event: any) => {
        try {
          expect(event.orderPubkey.toBase58()).to.equal(orderPda.toBase58());
        } catch (e) {
          console.error("Event assertion failed:", e);
          throw e;
        }
      }
    );

    // 创建一个sol订单
    const [orderPda, openOrderParams, bump] = await createSolOrder(
      program,
      user,
      amount,
      expiry
    );

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
        8 + 32 + 8 + 8 + 8 + 32 + 32 + 32 + 8 + 32 + 1
      );
    const actualDeposit = accountInfo.lamports - rentExempt;

    expect(actualDeposit).to.equal(openOrderParams.amountIn.toNumber());
  });
});

describe("cancelOrder test", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.limitOrder as anchor.Program;
  const user = provider.wallet.publicKey;

  // Derive global_config PDA
  let globalConfigPda: PublicKey;
  [globalConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  );

  it("should cancel a SOL limit order", async () => {
    const platformFee = 50;
    const treasury = user;

    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const amount = new anchor.BN(1_000_000);

    // 创建一个sol订单
    const [orderPda, openOrderParams, bump] = await createSolOrder(
      program,
      user,
      amount,
      expiry
    );

    // 事件监听器
    const listener = await program.addEventListener(
      "OrderCancelled",
      (event: any) => {
        expect(event.orderPubkey.toBase58()).to.equal(orderPda.toBase58());
        expect(event.by.toBase58()).to.equal(user.toBase58());
      }
    );

    // 取消前余额
    const refundReceiverBefore = await provider.connection.getBalance(user);

    await program.methods
      .cancelOrderSol()
      .accounts({
        order: orderPda,
        user,
        refundReceiver: user,
        globalConfig: globalConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await new Promise((r) => setTimeout(r, 500));
    await program.removeEventListener(listener);

    // 取消后余额
    const refundReceiverAfter = await provider.connection.getBalance(user);
    expect(refundReceiverAfter).to.be.greaterThan(refundReceiverBefore);

    const closedOrderInfo = await provider.connection.getAccountInfo(orderPda);
    expect(closedOrderInfo).to.be.null;
  });

  it("should cancel a SPL-token limit order", async () => {
    // 1. 创建测试 SPL Token mint
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

    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const amount = new anchor.BN(1_000_000);

    // 4. 创建 SPL 订单
    const [orderPda, orderTokenAccount, openOrderParams, bump] =
      await createSplOrder(program, provider, user, mint, amount, expiry);

    const orderAccountInfo = await getAccount(
      provider.connection,
      orderTokenAccount
    );

    // 取消前用户token账户余额
    const userTokenAccountBefore = await getAccount(
      provider.connection,
      userTokenAccount.address
    );

    // 事件监听器
    const listener = await program.addEventListener(
      "OrderCancelled",
      (event: any) => {
        expect(event.orderPubkey.toBase58()).to.equal(orderPda.toBase58());
        expect(event.by.toBase58()).to.equal(user.toBase58());
      }
    );

    // 取消订单
    await program.methods
      .cancelOrderSpl()
      .accounts({
        order: orderPda,
        user: user,
        userTokenAccount: userTokenAccount.address,
        orderTokenAccount: orderTokenAccount,
        refundReceiver: user,
        globalConfig: globalConfigPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await new Promise((r) => setTimeout(r, 500));
    await program.removeEventListener(listener);

    // 取消后用户token账户余额
    const userTokenAccountAfter = await getAccount(
      provider.connection,
      userTokenAccount.address
    );

    // 断言用户token账户余额增加了（因为退回了）
    expect(Number(userTokenAccountAfter.amount)).to.be.greaterThan(
      Number(userTokenAccountBefore.amount)
    );

    // 校验 order 账户已关闭
    const closedOrderInfo = await provider.connection.getAccountInfo(orderPda);
    expect(closedOrderInfo).to.be.null;

    // 校验 order_token_account 账户已关闭
    const closedTokenInfo = await provider.connection.getAccountInfo(
      orderTokenAccount
    );
    expect(closedTokenInfo).to.be.null;
  });
});

describe("executeOrderSol test", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.limitOrder as anchor.Program;
  const user = provider.wallet.publicKey;

  // Derive global_config PDA
  let globalConfigPda: PublicKey;
  [globalConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  );

  it("should execute a SOL limit order and distribute funds", async () => {
    // 1. Create SOL order
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const amountIn = new anchor.BN(10_000_000);
    const [orderPda, openOrderParams, bump] = await createSolOrder(
      program,
      user,
      amountIn,
      expiry
    );

    // 2. 准备 targetSol 账户（接受订单金额的账户）
    const targetKeypair = anchor.web3.Keypair.generate();
    const targetSol = targetKeypair.publicKey;

    // 3. 执行前的余额
    const targetBefore = await provider.connection.getBalance(targetSol);

    const treasuryBefore = await provider.connection.getBalance(user);

    // 4. 添加事件监听器
    const listener = await program.addEventListener(
      "OrderExecuted",
      (event: any) => {
        expect(event.orderPubkey.toBase58()).to.equal(orderPda.toBase58());
        expect(event.by.toBase58()).to.equal(user.toBase58());
        expect(event.nativeTokenVolume.toString()).to.equal("10000000");
      }
    );

    // 5. 执行订单
    await program.methods
      .executeOrderSol(new anchor.BN(10_000_000))
      .accounts({
        order: orderPda,
        targetSol: targetSol,
        treasury: user,
        executor: user,
        globalConfig: globalConfigPda,
        refundReceiver: user,
      })
      .rpc();

    await new Promise((r) => setTimeout(r, 500));
    await program.removeEventListener(listener);

    // 6. 验证分发金额
    const targetAfter = await provider.connection.getBalance(targetSol);

    const fee = Math.floor((amountIn.toNumber() * 50) / 10_000);
    const sendAmount = amountIn.toNumber() - fee;

    expect(targetAfter - targetBefore).to.equal(sendAmount);

    const treasuryAfter = await provider.connection.getBalance(user);
    expect(treasuryAfter - treasuryBefore).to.be.at.least(fee);

    // 7. 验证订单账户是否已关闭（执行后 rent 退回）
    const orderInfo = await provider.connection.getAccountInfo(orderPda);
    expect(orderInfo).to.be.null;
  });

  it("should execute a SPL limit order and distribute tokens", async () => {
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const amountIn = new anchor.BN(1_000_000);

    // 1. Create test SPL token mint
    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      user,
      null,
      6
    );

    // 2. Create user's ATA and mint tokens
    const userTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      user
    );
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      userTokenAccount.address,
      user,
      amountIn.toNumber()
    );

    // 3. Create target token account (receiver)
    const receiver = anchor.web3.Keypair.generate();
    const targetTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      receiver.publicKey
    );

    // 4. Derive treasury ATA
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      user, // user is acting as treasury here
      false
    );

    // 5. Create order
    const [orderPda, orderTokenAccount, openOrderParams, bump] =
      await createSplOrder(program, provider, user, mint, amountIn, expiry);

    // 6. Check treasury ATA (create if not exists)
    const treasuryAtaInfo = await provider.connection.getAccountInfo(
      treasuryAta
    );
    if (!treasuryAtaInfo) {
      await createAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        mint,
        user
      );
    }

    // 7. Capture balances before
    const targetBefore = await getAccount(
      provider.connection,
      targetTokenAccount.address
    );
    const treasuryBefore = await getAccount(provider.connection, treasuryAta);

    // 8. Listen for event
    const listener = await program.addEventListener(
      "OrderExecuted",
      (event: any) => {
        expect(event.orderPubkey.toBase58()).to.equal(orderPda.toBase58());
        expect(event.by.toBase58()).to.equal(user.toBase58());
        expect(event.nativeTokenVolume.toString()).to.equal("0"); // For SPL
      }
    );

    // 9. Execute order
    await program.methods
      .executeOrderSpl(new anchor.BN(0)) // SPL case
      .accounts({
        order: orderPda,
        orderTokenAccount: orderTokenAccount,
        targetTokenAccount: targetTokenAccount.address,
        treasuryTokenAccount: treasuryAta,
        globalConfig: globalConfigPda,
        refundReceiver: user,
        executor: user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await new Promise((r) => setTimeout(r, 500));
    await program.removeEventListener(listener);

    // 10. Balance check after
    const targetAfter = await getAccount(
      provider.connection,
      targetTokenAccount.address
    );
    const treasuryAfter = await getAccount(provider.connection, treasuryAta);

    const fee = Math.floor((amountIn.toNumber() * 50) / 10000);
    const sendAmount = amountIn.toNumber() - fee;

    expect(Number(targetAfter.amount) - Number(targetBefore.amount)).to.equal(
      sendAmount
    );
    expect(
      Number(treasuryAfter.amount) - Number(treasuryBefore.amount)
    ).to.equal(fee);

    // 11. Check order token account closed
    const closed = await provider.connection.getAccountInfo(orderTokenAccount);
    expect(closed).to.be.null;

    const orderInfo = await provider.connection.getAccountInfo(orderPda);
    expect(orderInfo).to.be.null;
  });
});
