/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/meridian.json`.
 */
export type Meridian = {
  "address": "499QonPencmcxszHqjKKsMUE6dnbWh1AJ4f9LTrv9t1s",
  "metadata": {
    "name": "meridian",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Binary stock outcome markets on Solana — Anchor program",
    "repository": "https://github.com/scott-lydon/meridian"
  },
  "instructions": [
    {
      "name": "adminSettle",
      "docs": [
        "Admin override settle. Enforces market.admin_override_earliest",
        "(created_at + config.admin_override_delay_secs) on-chain."
      ],
      "discriminator": [
        138,
        218,
        221,
        118,
        96,
        220,
        75,
        11
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "closingPriceMicros",
          "type": "u64"
        }
      ]
    },
    {
      "name": "cancelOrder",
      "docs": [
        "Owner cancels an unfilled order, gets remaining escrow back."
      ],
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "market"
        },
        {
          "name": "orderBook",
          "writable": true
        },
        {
          "name": "bookAuthority"
        },
        {
          "name": "usdcEscrow",
          "writable": true
        },
        {
          "name": "yesEscrow",
          "writable": true
        },
        {
          "name": "userUsdc",
          "writable": true
        },
        {
          "name": "userYes",
          "writable": true
        },
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": {
            "defined": {
              "name": "orderSide"
            }
          }
        },
        {
          "name": "sequence",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createStrikeMarket",
      "docs": [
        "Admin creates one market: one (trading-day, ticker, strike) tuple.",
        "Initializes Yes/No mints, vault, and Market PDA. `pyth_feed_id`",
        "is stored on the market so settle_market (slice 2) can verify on chain."
      ],
      "discriminator": [
        21,
        162,
        50,
        119,
        68,
        218,
        221,
        35
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "vaultAuthority",
          "docs": [
            "authority for Yes/No. No state; just a derived address."
          ]
        },
        {
          "name": "yesMint",
          "writable": true
        },
        {
          "name": "noMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultAuthority"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "tradingDayUnix",
          "type": "i64"
        },
        {
          "name": "ticker",
          "type": {
            "array": [
              "u8",
              6
            ]
          }
        },
        {
          "name": "strikeUsdMicros",
          "type": "u64"
        },
        {
          "name": "expiryUnix",
          "type": "i64"
        },
        {
          "name": "pythFeedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initOrderBook",
      "docs": [
        "Admin creates the order-book PDA + escrow ATAs for a market."
      ],
      "discriminator": [
        225,
        19,
        88,
        90,
        233,
        246,
        140,
        84
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "market"
        },
        {
          "name": "orderBook",
          "writable": true
        },
        {
          "name": "bookAuthority"
        },
        {
          "name": "usdcEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bookAuthority"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "yesEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bookAuthority"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "yesMint"
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeConfig",
      "docs": [
        "One-time program setup. Admin signs, records USDC mint + thresholds.",
        "Pyth feeds attach via the per-market `pyth_feed_id` param in slice 1",
        "and via a dedicated registry in slice 2."
      ],
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "usdcMint",
          "docs": [
            "USDC mint. Recorded into Config; subsequent instructions verify against",
            "this so the program can never settle against a wrong-stable market."
          ]
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "mintPair",
      "docs": [
        "Anyone deposits N USDC and receives N Yes + N No tokens."
      ],
      "discriminator": [
        19,
        149,
        94,
        110,
        181,
        186,
        33,
        107
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "vaultAuthority"
        },
        {
          "name": "yesMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdc",
          "docs": [
            "User's USDC source account."
          ],
          "writable": true
        },
        {
          "name": "userYes",
          "docs": [
            "User's Yes destination ATA."
          ],
          "writable": true
        },
        {
          "name": "userNo",
          "docs": [
            "User's No destination ATA."
          ],
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "qty",
          "type": "u64"
        }
      ]
    },
    {
      "name": "pause",
      "docs": [
        "Pause all minting and order placement (redeem keeps working)."
      ],
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "placeOrder",
      "docs": [
        "Post a limit order. Escrows the user's tokens and inserts a resting",
        "order. Matching happens in a separate `match_orders` cranker."
      ],
      "discriminator": [
        51,
        194,
        155,
        175,
        109,
        130,
        96,
        106
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "market"
        },
        {
          "name": "orderBook",
          "writable": true
        },
        {
          "name": "usdcEscrow",
          "writable": true
        },
        {
          "name": "yesEscrow",
          "writable": true
        },
        {
          "name": "userUsdc",
          "docs": [
            "USDC source (Bid path)."
          ],
          "writable": true
        },
        {
          "name": "userYes",
          "docs": [
            "Yes source (Ask path)."
          ],
          "writable": true
        },
        {
          "name": "yesMint"
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": {
            "defined": {
              "name": "orderSide"
            }
          }
        },
        {
          "name": "priceTicks",
          "type": "u32"
        },
        {
          "name": "qty",
          "type": "u64"
        }
      ]
    },
    {
      "name": "redeem",
      "docs": [
        "Burn winning tokens for $1.00 each. Losing tokens redeem for $0.00",
        "(the burn still succeeds; rent on the ATA returns to the user)."
      ],
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "vaultAuthority"
        },
        {
          "name": "yesMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdc",
          "docs": [
            "USDC destination for the redeemer."
          ],
          "writable": true
        },
        {
          "name": "userYes",
          "docs": [
            "User's Yes ATA. Mutated only when side == Yes."
          ],
          "writable": true
        },
        {
          "name": "userNo",
          "docs": [
            "User's No ATA. Mutated only when side == No."
          ],
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": {
            "defined": {
              "name": "redeemSide"
            }
          }
        },
        {
          "name": "qty",
          "type": "u64"
        }
      ]
    },
    {
      "name": "settleMarketManual",
      "docs": [
        "Admin-only stub settlement used by tests and dev workflows.",
        "Real Pyth-driven `settle_market` lands in slice 2."
      ],
      "discriminator": [
        164,
        135,
        165,
        159,
        9,
        65,
        193,
        253
      ],
      "accounts": [
        {
          "name": "config"
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "closingPriceMicros",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unpause",
      "docs": [
        "Resume normal operation."
      ],
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "orderBook",
      "discriminator": [
        55,
        230,
        125,
        218,
        149,
        39,
        65,
        248
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Caller is not the program admin"
    },
    {
      "code": 6001,
      "name": "configAlreadyInitialized",
      "msg": "Config has already been initialized; call again denied"
    },
    {
      "code": 6002,
      "name": "programPaused",
      "msg": "Mint/trade attempted while the program is paused"
    },
    {
      "code": 6003,
      "name": "marketNotSettled",
      "msg": "Market has not been settled yet; redeem disabled until settle_market lands"
    },
    {
      "code": 6004,
      "name": "marketAlreadySettled",
      "msg": "Market is already settled; outcome is immutable"
    },
    {
      "code": 6005,
      "name": "settleTooEarly",
      "msg": "settle_market called before market close (16:00 ET)"
    },
    {
      "code": 6006,
      "name": "adminOverrideTooEarly",
      "msg": "admin_settle called before the override delay elapsed"
    },
    {
      "code": 6007,
      "name": "oraclePriceStale",
      "msg": "Pyth price is older than max_staleness_secs"
    },
    {
      "code": 6008,
      "name": "oracleConfidenceTooWide",
      "msg": "Pyth confidence band wider than max_confidence_bps"
    },
    {
      "code": 6009,
      "name": "oracleFeedMismatch",
      "msg": "Pyth account passed does not match the feed configured for this ticker"
    },
    {
      "code": 6010,
      "name": "oracleUpdateMissing",
      "msg": "Pyth update missing or malformed"
    },
    {
      "code": 6011,
      "name": "invalidQuantity",
      "msg": "Quantity must be positive"
    },
    {
      "code": 6012,
      "name": "mathOverflow",
      "msg": "Integer overflow in vault accounting"
    },
    {
      "code": 6013,
      "name": "insufficientBalance",
      "msg": "Caller balance is insufficient for the requested action"
    },
    {
      "code": 6014,
      "name": "vaultInvariantViolated",
      "msg": "Vault balance no longer equals total_pairs_outstanding x 1.00 USDC"
    },
    {
      "code": 6015,
      "name": "unknownTicker",
      "msg": "Ticker not present in Config.pyth_feeds"
    },
    {
      "code": 6016,
      "name": "invalidStrike",
      "msg": "Strike price must be a positive integer in micro-USD"
    },
    {
      "code": 6017,
      "name": "invalidTradingDay",
      "msg": "Trading-day timestamp does not align with a UTC midnight"
    },
    {
      "code": 6018,
      "name": "invalidOrderBookCapacity",
      "msg": "Order-book capacity must fit within program limits"
    },
    {
      "code": 6019,
      "name": "wrongTokenMint",
      "msg": "Provided token mint does not match the expected Yes or No mint for this market"
    },
    {
      "code": 6020,
      "name": "wrongVaultAccount",
      "msg": "Provided vault account does not match the market's vault PDA"
    },
    {
      "code": 6021,
      "name": "orderBookFull",
      "msg": "Order book side is at capacity"
    },
    {
      "code": 6022,
      "name": "orderNotFound",
      "msg": "Order not found (owner + sequence did not match)"
    },
    {
      "code": 6023,
      "name": "iocPartialFillRejected",
      "msg": "IOC order could not be fully filled at the requested price"
    },
    {
      "code": 6024,
      "name": "invalidOrderPrice",
      "msg": "Order price must be between 1 and 99 ticks ($0.01 to $0.99)"
    }
  ],
  "types": [
    {
      "name": "config",
      "docs": [
        "Global program configuration set once at deploy time by the admin.",
        "",
        "Note: Pyth feeds intentionally live OFF this account. Storing the 7",
        "feeds inline blew the on-chain BPF stack when create_strike_market",
        "deserialized Config (Anchor copies through the stack). Feeds are now",
        "either (a) passed directly to create_strike_market by the admin, or",
        "(b) verified via the Pyth receiver SDK at settle time (slice 2)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "Admin pubkey that can create markets, settle via override, pause."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "docs": [
              "Devnet USDC mint (Circle's official); recorded so callers can verify."
            ],
            "type": "pubkey"
          },
          {
            "name": "maxStalenessSecs",
            "docs": [
              "Reject Pyth prices older than this many seconds at settlement."
            ],
            "type": "u64"
          },
          {
            "name": "maxConfidenceBps",
            "docs": [
              "Reject Pyth prices whose confidence exceeds this many basis points",
              "of the price. 50 bps = 0.5%."
            ],
            "type": "u16"
          },
          {
            "name": "adminOverrideDelaySecs",
            "docs": [
              "Seconds the admin must wait after market close before `admin_settle`",
              "becomes callable. Slice 2 enforces this on-chain."
            ],
            "type": "i64"
          },
          {
            "name": "paused",
            "docs": [
              "Global pause flag. When set, mint and trading reject; redeem continues",
              "to work (see constitution §2.10)."
            ],
            "type": "bool"
          },
          {
            "name": "version",
            "docs": [
              "Bumped on any breaking change to layouts or PDAs."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "market",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "docs": [
              "Pointer back to the parent Config (set at create_strike_market)."
            ],
            "type": "pubkey"
          },
          {
            "name": "tradingDayUnix",
            "docs": [
              "UTC midnight of the trading day this market settles on."
            ],
            "type": "i64"
          },
          {
            "name": "ticker",
            "docs": [
              "Ticker (e.g. b\"META\\0\\0\")."
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "strikeUsdMicros",
            "docs": [
              "Strike price in 6-decimal USDC base units (micros).",
              "e.g. $680.00 == 680_000_000."
            ],
            "type": "u64"
          },
          {
            "name": "yesMint",
            "docs": [
              "SPL mint for Yes tokens (0 decimals)."
            ],
            "type": "pubkey"
          },
          {
            "name": "noMint",
            "docs": [
              "SPL mint for No tokens (0 decimals)."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "USDC ATA owned by `vault_authority`."
            ],
            "type": "pubkey"
          },
          {
            "name": "vaultAuthorityBump",
            "docs": [
              "PDA bumps captured so signers can be reconstructed cheaply."
            ],
            "type": "u8"
          },
          {
            "name": "yesMintBump",
            "type": "u8"
          },
          {
            "name": "noMintBump",
            "type": "u8"
          },
          {
            "name": "createdAtUnix",
            "docs": [
              "Set by `create_strike_market` from Clock."
            ],
            "type": "i64"
          },
          {
            "name": "expiryUnix",
            "docs": [
              "16:00 ET of `trading_day_unix`."
            ],
            "type": "i64"
          },
          {
            "name": "adminOverrideEarliest",
            "docs": [
              "`created_at_unix + admin_override_delay_secs`. Slice 5 enforces."
            ],
            "type": "i64"
          },
          {
            "name": "pythFeedId",
            "docs": [
              "Pyth feed id for the underlying ticker (mirrored from Config for",
              "O(1) verification at settle time)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outcome",
            "docs": [
              "Settlement state. `OutcomeState::Pending` until settle lands."
            ],
            "type": {
              "defined": {
                "name": "outcome"
              }
            }
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump for this Market account."
            ],
            "type": "u8"
          },
          {
            "name": "version",
            "docs": [
              "Account-layout version."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "order",
      "docs": [
        "Pod-compatible: every field repr(C)-laid-out with no implicit padding.",
        "Layout: 8 + 8 + 32 + 4 + 1 + 3 = 56 bytes, naturally aligned.",
        "",
        "`AnchorSerialize`/`Deserialize` for the IDL; `Pod`/`Zeroable` for the",
        "zero-copy OrderBook account."
      ],
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "qty",
            "type": "u64"
          },
          {
            "name": "sequence",
            "type": "u64"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "priceTicks",
            "type": "u32"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          }
        ]
      }
    },
    {
      "name": "orderBook",
      "docs": [
        "Zero-copy OrderBook. Loaded via `AccountLoader<'info, OrderBook>`,",
        "accessed via `.load()?` (read) or `.load_mut()?` (write)."
      ],
      "serialization": "bytemuckunsafe",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "usdcEscrow",
            "type": "pubkey"
          },
          {
            "name": "yesEscrow",
            "type": "pubkey"
          },
          {
            "name": "nextSequence",
            "type": "u64"
          },
          {
            "name": "bidsLen",
            "type": "u32"
          },
          {
            "name": "asksLen",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "pad0",
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "bids",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "order"
                  }
                },
                64
              ]
            }
          },
          {
            "name": "asks",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "order"
                  }
                },
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "orderSide",
      "docs": [
        "Wire-format side. Stored as u8 in Order so OrderBook is Pod-compatible."
      ],
      "repr": {
        "kind": "rust"
      },
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "bid"
          },
          {
            "name": "ask"
          }
        ]
      }
    },
    {
      "name": "outcome",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "outcomeState"
              }
            }
          },
          {
            "name": "closingPriceMicros",
            "docs": [
              "Closing price in micro-USD as reported by the oracle (or admin override).",
              "Zero before settlement."
            ],
            "type": "u64"
          },
          {
            "name": "settledAtUnix",
            "docs": [
              "Unix timestamp the outcome was written. Zero before settlement."
            ],
            "type": "i64"
          },
          {
            "name": "adminOverride",
            "docs": [
              "True if settled via `admin_settle` (the override path)."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "outcomeState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "yesWins"
          },
          {
            "name": "noWins"
          }
        ]
      }
    },
    {
      "name": "redeemSide",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "yes"
          },
          {
            "name": "no"
          }
        ]
      }
    }
  ]
};
