import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BondingCurve } from "../target/types/bonding_curve"
import { Connection, PublicKey, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js"
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddress } from "@solana/spl-token"
import { expect } from "chai";
import { BN } from "bn.js";
import keys from '../keys/users.json'
import key2 from '../keys/user2.json'
import { ASSOCIATED_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";

// const connection = new Connection("https://api.devnet.solana.com")
const connection = new Connection("http://localhost:8899")
const curveSeed = "CurveConfiguration"
const POOL_SEED_PREFIX = "liquidity_pool"
const SOL_VAULT_PREFIX = "liquidity_sol_vault"

/**
 * Sends a transaction and asserts that it fails. Useful for testing error conditions.
 */
async function sendTxExpectError(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  description = "Transaction"
): Promise<void> {
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  let threw = false;
  try {
    await sendAndConfirmTransaction(conn, tx, signers, { skipPreflight: false });
  } catch {
    threw = true;
  }
  expect(threw, `${description} should have failed but succeeded`).to.be.true;
}

describe("bonding_curve", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.BondingCurve as Program<BondingCurve>;

  const user = Keypair.fromSecretKey(new Uint8Array(keys))
  const user2 = Keypair.fromSecretKey(new Uint8Array(key2))
  const tokenDecimal = 9
  // Total supply: 1_000_000_000 tokens with 9 decimal places = 1e18 base units
  const amount = new BN(1000000000).mul(new BN(10 ** tokenDecimal))

  let mint1: PublicKey
  let tokenAta1: PublicKey

  console.log("Admin's wallet address is : ", user.publicKey.toBase58())

  it("Airdrop to admin wallet", async () => {
    console.log(`Requesting airdrop to admin : ${user.publicKey.toBase58()}`)
    const signature = await connection.requestAirdrop(user.publicKey, 10 * 10 ** 9);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'finalized');
    const balance = await connection.getBalance(user.publicKey);
    console.log("admin wallet balance : ", balance / 10 ** 9, "SOL")
    expect(balance).to.be.gt(0);
  })

  it("Airdrop to user2 wallet", async () => {
    console.log(`Requesting airdrop to user2 : ${user2.publicKey.toBase58()}`)
    const signature = await connection.requestAirdrop(user2.publicKey, 10 * 10 ** 9);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'finalized');
    const balance = await connection.getBalance(user2.publicKey);
    console.log("user2 wallet balance : ", balance / 10 ** 9, "SOL")
    expect(balance).to.be.gt(0);
  })

  it("Mint token1 to user wallet", async () => {
    console.log("Creating and minting token1 to user's wallet")
    mint1 = await createMint(connection, user, user.publicKey, user.publicKey, tokenDecimal)
    console.log('mint1 address: ', mint1.toBase58());
    tokenAta1 = (await getOrCreateAssociatedTokenAccount(connection, user, mint1, user.publicKey)).address
    console.log('token1 account address: ', tokenAta1.toBase58());
    await mintTo(connection, user, mint1, tokenAta1, user.publicKey, BigInt(amount.toString()))
    const tokenBalance = await connection.getTokenAccountBalance(tokenAta1)
    console.log("tokenBalance1 in user:", tokenBalance.value.uiAmount)
    // 1e18 base units / 1e9 decimal = 1_000_000_000 tokens displayed
    expect(tokenBalance.value.uiAmount).to.equal(1_000_000_000);
  })

  it("Initialize fails with fee below 0", async () => {
    const [curveConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(curveSeed)],
      program.programId
    )
    const tx = new Transaction().add(
      await program.methods
        .initialize(-1)
        .accounts({
          dexConfigurationAccount: curveConfig,
          admin: user.publicKey,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId
        })
        .instruction()
    )
    tx.feePayer = user.publicKey
    await sendTxExpectError(connection, tx, [user], "initialize with fee=-1");
  })

  it("Initialize fails with fee above 100", async () => {
    const [curveConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(curveSeed)],
      program.programId
    )
    const tx = new Transaction().add(
      await program.methods
        .initialize(101)
        .accounts({
          dexConfigurationAccount: curveConfig,
          admin: user.publicKey,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId
        })
        .instruction()
    )
    tx.feePayer = user.publicKey
    await sendTxExpectError(connection, tx, [user], "initialize with fee=101");
  })

  it("Initialize the contract", async () => {
    const [curveConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(curveSeed)],
      program.programId
    )
    const tx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1200_000 }),
        await program.methods
          .initialize(1)
          .accounts({
            dexConfigurationAccount: curveConfig,
            admin: user.publicKey,
            rent: SYSVAR_RENT_PUBKEY,
            systemProgram: SystemProgram.programId
          })
          .instruction()
      )
    tx.feePayer = user.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    const sig = await sendAndConfirmTransaction(connection, tx, [user], { skipPreflight: true })
    console.log("Successfully initialized : ", sig)
    const dexConfig = await program.account.curveConfiguration.fetch(curveConfig)
    console.log("Dex config state : ", dexConfig)
    expect(dexConfig.fees).to.equal(1);
  });

  it("create pool", async () => {
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(POOL_SEED_PREFIX), mint1.toBuffer()],
      program.programId
    )
    const poolToken = await getAssociatedTokenAddress(mint1, poolPda, true)
    const tx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        await program.methods
          .createPool()
          .accounts({
            pool: poolPda,
            tokenMint: mint1,
            poolTokenAccount: poolToken,
            payer: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
            systemProgram: SystemProgram.programId
          })
          .instruction()
      )
    tx.feePayer = user.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    const sig = await sendAndConfirmTransaction(connection, tx, [user], { skipPreflight: true })
    console.log("Successfully created pool : ", sig)

    const pool = await program.account.liquidityPool.fetch(poolPda)
    expect(pool.creator.toBase58()).to.equal(user.publicKey.toBase58());
    expect(pool.token.toBase58()).to.equal(mint1.toBase58());
    expect(pool.totalSupply.toString()).to.equal("0");
    expect(pool.reserveToken.toString()).to.equal("0");
    expect(pool.reserveSol.toString()).to.equal("0");
  })

  it("add liquidity", async () => {
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(POOL_SEED_PREFIX), mint1.toBuffer()],
      program.programId
    )
    const [poolSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from(SOL_VAULT_PREFIX), mint1.toBuffer()],
      program.programId
    )
    const poolToken = await getAssociatedTokenAddress(mint1, poolPda, true)
    const userAta1 = await getAssociatedTokenAddress(mint1, user.publicKey)

    const tx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        await program.methods
          .addLiquidity()
          .accounts({
            pool: poolPda,
            poolSolVault: poolSolVault,
            tokenMint: mint1,
            poolTokenAccount: poolToken,
            userTokenAccount: userAta1,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            systemProgram: SystemProgram.programId
          })
          .instruction()
      )
    tx.feePayer = user.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    const sig = await sendAndConfirmTransaction(connection, tx, [user], { skipPreflight: true })
    console.log("Successfully added liquidity : ", sig)

    const pool = await program.account.liquidityPool.fetch(poolPda)
    // reserve_sol is seeded with INITIAL_LAMPORTS_FOR_POOL = 10_000_000 (0.01 SOL)
    expect(pool.reserveSol.toNumber()).to.equal(10_000_000);
    // reserve_token equals the full mint supply transferred to the pool
    expect(pool.reserveToken.toString()).to.equal(amount.toString());
    // total_supply is set to 1e18 as a fixed constant
    expect(pool.totalSupply.toString()).to.equal("1000000000000000000");

    // All user tokens were moved to the pool
    const userBalance = await connection.getTokenAccountBalance(userAta1)
    const poolBalance = await connection.getTokenAccountBalance(poolToken)
    console.log("after add_liquidity => userBalance:", userBalance.value.uiAmount)
    console.log("after add_liquidity => poolBalance:", poolBalance.value.uiAmount)
    expect(userBalance.value.uiAmount).to.equal(0);
    expect(poolBalance.value.uiAmount).to.equal(1_000_000_000);
  })

  it("Buy fails with zero amount", async () => {
    const [curveConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(curveSeed)], program.programId
    )
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(POOL_SEED_PREFIX), mint1.toBuffer()], program.programId
    )
    const poolToken = await getAssociatedTokenAddress(mint1, poolPda, true)
    const userAta1 = await getAssociatedTokenAddress(mint1, user.publicKey)
    const [poolSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from(SOL_VAULT_PREFIX), mint1.toBuffer()], program.programId
    )
    const tx = new Transaction().add(
      await program.methods
        .buy(new BN(0))
        .accounts({
          pool: poolPda,
          tokenMint: mint1,
          poolSolVault,
          poolTokenAccount: poolToken,
          userTokenAccount: userAta1,
          dexConfigurationAccount: curveConfig,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId
        })
        .instruction()
    )
    tx.feePayer = user.publicKey
    await sendTxExpectError(connection, tx, [user], "buy with amount=0");
  })

  it("Buy token", async () => {
    const [curveConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(curveSeed)], program.programId
    )
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(POOL_SEED_PREFIX), mint1.toBuffer()], program.programId
    )
    const poolToken = await getAssociatedTokenAddress(mint1, poolPda, true)
    const userAta1 = await getAssociatedTokenAddress(mint1, user.publicKey)
    const [poolSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from(SOL_VAULT_PREFIX), mint1.toBuffer()], program.programId
    )

    const poolBefore = await program.account.liquidityPool.fetch(poolPda)
    const buyAmount = new BN(10 ** 8) // 0.1 SOL in lamports

    const tx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        await program.methods
          .buy(buyAmount)
          .accounts({
            pool: poolPda,
            tokenMint: mint1,
            poolSolVault,
            poolTokenAccount: poolToken,
            userTokenAccount: userAta1,
            dexConfigurationAccount: curveConfig,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            systemProgram: SystemProgram.programId
          })
          .instruction()
      )
    tx.feePayer = user.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    const sig = await sendAndConfirmTransaction(connection, tx, [user], { skipPreflight: true })
    console.log("Successfully bought : ", sig)

    const poolAfter = await program.account.liquidityPool.fetch(poolPda)
    // reserve_sol increases by the SOL amount sent
    expect(poolAfter.reserveSol.toNumber()).to.equal(
      poolBefore.reserveSol.toNumber() + buyAmount.toNumber()
    );
    // reserve_token decreases as tokens are sent to the buyer
    expect(poolAfter.reserveToken.lt(poolBefore.reserveToken)).to.be.true;

    // Buyer's token account now has a positive balance
    const userBalance = await connection.getTokenAccountBalance(userAta1)
    console.log("user token balance after buy:", userBalance.value.uiAmount)
    expect(userBalance.value.uiAmount).to.be.gt(0);
  })

  it("Sell fails with zero amount", async () => {
    const [curveConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(curveSeed)], program.programId
    )
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(POOL_SEED_PREFIX), mint1.toBuffer()], program.programId
    )
    const poolToken = await getAssociatedTokenAddress(mint1, poolPda, true)
    const userAta1 = await getAssociatedTokenAddress(mint1, user.publicKey)
    const [poolSolVault, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from(SOL_VAULT_PREFIX), mint1.toBuffer()], program.programId
    )
    const tx = new Transaction().add(
      await program.methods
        .sell(new BN(0), bump)
        .accounts({
          pool: poolPda,
          tokenMint: mint1,
          poolSolVault,
          poolTokenAccount: poolToken,
          userTokenAccount: userAta1,
          dexConfigurationAccount: curveConfig,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId
        })
        .instruction()
    )
    tx.feePayer = user.publicKey
    await sendTxExpectError(connection, tx, [user], "sell with amount=0");
  })

  it("User2 can buy tokens", async () => {
    const [curveConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(curveSeed)], program.programId
    )
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(POOL_SEED_PREFIX), mint1.toBuffer()], program.programId
    )
    const poolToken = await getAssociatedTokenAddress(mint1, poolPda, true)
    const user2Ata1 = await getAssociatedTokenAddress(mint1, user2.publicKey)
    const [poolSolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from(SOL_VAULT_PREFIX), mint1.toBuffer()], program.programId
    )

    const poolBefore = await program.account.liquidityPool.fetch(poolPda)
    const buyAmount = new BN(5 * 10 ** 7) // 0.05 SOL in lamports

    const tx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        await program.methods
          .buy(buyAmount)
          .accounts({
            pool: poolPda,
            tokenMint: mint1,
            poolSolVault,
            poolTokenAccount: poolToken,
            userTokenAccount: user2Ata1,
            dexConfigurationAccount: curveConfig,
            user: user2.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            systemProgram: SystemProgram.programId
          })
          .instruction()
      )
    tx.feePayer = user2.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    const sig = await sendAndConfirmTransaction(connection, tx, [user2], { skipPreflight: true })
    console.log("user2 successfully bought : ", sig)

    const poolAfter = await program.account.liquidityPool.fetch(poolPda)
    expect(poolAfter.reserveSol.toNumber()).to.equal(
      poolBefore.reserveSol.toNumber() + buyAmount.toNumber()
    );
    expect(poolAfter.reserveToken.lt(poolBefore.reserveToken)).to.be.true;

    const user2Balance = await connection.getTokenAccountBalance(user2Ata1)
    console.log("user2 token balance after buy:", user2Balance.value.uiAmount)
    expect(user2Balance.value.uiAmount).to.be.gt(0);
  })

  it("Sell token", async () => {
    const [curveConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(curveSeed)], program.programId
    )
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(POOL_SEED_PREFIX), mint1.toBuffer()], program.programId
    )
    const poolToken = await getAssociatedTokenAddress(mint1, poolPda, true)
    const userAta1 = await getAssociatedTokenAddress(mint1, user.publicKey)
    const [poolSolVault, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from(SOL_VAULT_PREFIX), mint1.toBuffer()], program.programId
    )

    const poolBefore = await program.account.liquidityPool.fetch(poolPda)

    // Sell 1% of the total supply worth of tokens (which the user obtained by buying)
    const sellAmount = amount.div(new BN(100))

    const tx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        await program.methods
          .sell(sellAmount, bump)
          .accounts({
            pool: poolPda,
            tokenMint: mint1,
            poolSolVault,
            poolTokenAccount: poolToken,
            userTokenAccount: userAta1,
            dexConfigurationAccount: curveConfig,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            systemProgram: SystemProgram.programId
          })
          .instruction()
      )
    tx.feePayer = user.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    const sig = await sendAndConfirmTransaction(connection, tx, [user], { skipPreflight: true })
    console.log("Successfully sold : ", sig)

    const poolAfter = await program.account.liquidityPool.fetch(poolPda)
    // reserve_token increases as tokens are returned to the pool
    expect(poolAfter.reserveToken.gt(poolBefore.reserveToken)).to.be.true;
    // reserve_sol decreases as SOL is paid out to the seller
    expect(poolAfter.reserveSol.lt(poolBefore.reserveSol)).to.be.true;
  })


  it("Remove liquidity", async () => {
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(POOL_SEED_PREFIX), mint1.toBuffer()],
      program.programId
    )
    const poolToken = await getAssociatedTokenAddress(mint1, poolPda, true)
    const userAta1 = await getAssociatedTokenAddress(mint1, user.publicKey)
    const [poolSolVault, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from(SOL_VAULT_PREFIX), mint1.toBuffer()],
      program.programId
    )

    const poolTokenBalanceBefore = await connection.getTokenAccountBalance(poolToken)
    console.log("pool token balance before remove:", poolTokenBalanceBefore.value.uiAmount)

    const tx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        await program.methods
          .removeLiquidity(bump)
          .accounts({
            pool: poolPda,
            tokenMint: mint1,
            poolTokenAccount: poolToken,
            userTokenAccount: userAta1,
            poolSolVault,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            systemProgram: SystemProgram.programId
          })
          .instruction()
      )
    tx.feePayer = user.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    const sig = await sendAndConfirmTransaction(connection, tx, [user], { skipPreflight: true })
    console.log("Successfully removed liquidity : ", sig)

    // All pool tokens should be returned to the liquidity provider
    const userTokenBalance = await connection.getTokenAccountBalance(userAta1)
    console.log("user token balance after remove:", userTokenBalance.value.uiAmount)
    expect(userTokenBalance.value.uiAmount).to.be.gt(0);

    // Pool token account should now be empty
    const poolTokenBalanceAfter = await connection.getTokenAccountBalance(poolToken)
    expect(poolTokenBalanceAfter.value.uiAmount).to.equal(0);
  })
});


