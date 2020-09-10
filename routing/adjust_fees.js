const asyncAuto = require('async/auto');
const asyncEach = require('async/each');
const asyncMap = require('async/map');
const asyncRetry = require('async/retry');
const {findKey} = require('ln-sync');
const {getChannel} = require('ln-service');
const {getChannels} = require('ln-service');
const {getFeeRates} = require('ln-service');
const {getNodeAlias} = require('ln-sync');
const {getPendingChannels} = require('ln-service');
const {gray} = require('colorette');
const {green} = require('colorette');
const {getWalletInfo} = require('ln-service');
const moment = require('moment');
const {returnResult} = require('asyncjs-util');
const {updateRoutingFees} = require('ln-service');

const {formatFeeRate} = require('./../display');
const updateChannelFee = require('./update_channel_fee');

const asTxOut = n => `${n.transaction_id}:${n.transaction_vout}`;
const flatten = arr => [].concat(...arr);
const interval = 1000 * 60 * 2;
const {isArray} = Array;
const {max} = Math;
const noFee = gray('Unknown Rate');
const shortKey = key => key.substring(0, 20);
const times = 360;
const uniq = arr => Array.from(new Set(arr));

/** View and adjust routing fees

  {
    [fee_rate]: <Fee Rate Parts Per Million Number>
    lnd: <Authenticated LND API Object>
    logger: <Winstone Logger Object>
    to: [<Adjust Routing Fee To Peer Alias or Public Key String>]
  }

  @returns via cbk or Promise
  {
    rows: [[<Table Cell String>]]
  }
*/
module.exports = (args, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguments
      validate: cbk => {
        if (!args.lnd) {
          return cbk([400, 'ExpectedLndToAdjustFeeRates']);
        }

        if (!args.logger) {
          return cbk([400, 'ExpectedLoggerToAdjustFeeRates']);
        }

        if (!isArray(args.to)) {
          return cbk([400, 'ExpectedArrayOfPeersToAdjustFeesTowards']);
        }

        return cbk();
      },

      // Get the channels
      getChannels: ['validate', ({}, cbk) => {
        return getChannels({lnd: args.lnd}, cbk);
      }],

      // Get the pending channels
      getPending: ['validate', ({}, cbk) => {
        return getPendingChannels({lnd: args.lnd}, cbk);
      }],

      // Get the wallet public key
      getPublicKey: ['validate', ({}, cbk) => {
        return getWalletInfo({lnd: args.lnd}, cbk);
      }],

      // Get the current fee rates
      getFeeRates: ['validate', ({}, cbk) => {
        return getFeeRates({lnd: args.lnd}, cbk);
      }],

      // Get the aliases of the channel partners
      getAliases: ['getChannels', ({getChannels}, cbk) => {
        const ids = uniq(getChannels.channels.map(n => n.partner_public_key));

        return asyncMap(ids, (id, cbk) => {
          return getNodeAlias({id, lnd: args.lnd}, cbk);
        },
        cbk);
      }],

      // Get the peers to assign fee rates towards
      getPeers: ['getChannels', ({getChannels}, cbk) => {
        const {channels} = getChannels;

        return asyncMap(args.to, (query, cbk) => {
          return findKey({channels, query, lnd: args.lnd}, cbk);
        },
        cbk);
      }],

      // Get the policies of all channels
      getPolicies: ['getChannels', ({getChannels}, cbk) => {
        return asyncMap(getChannels.channels, (channel, cbk) => {
          return getChannel({id: channel.id, lnd: args.lnd}, (err, res) => {
            if (isArray(err) && err.slice().shift() === 404) {
              return cbk();
            }

            if (!!err) {
              return cbk(err);
            }

            return cbk(null, res);
          });
        },
        cbk);
      }],

      // Set the fee rates of the specified channels
      updateFees: [
        'getChannels',
        'getFeeRates',
        'getPeers',
        'getPending',
        'getPolicies',
        'getPublicKey',
        ({
          getChannels,
          getFeeRates,
          getPeers,
          getPending,
          getPolicies,
          getPublicKey,
        },
        cbk) =>
      {
        if (args.fee_rate === undefined) {
          return cbk();
        }

        const ownKey = getPublicKey.public_key;
        const peerKeys = getPeers.map(n => n.public_key).filter(n => !!n);

        const updates = peerKeys.map(key => {
          const channels = []
            .concat(getChannels.channels)
            .concat(getPending.pending_channels)
            .filter(channel => channel.partner_public_key === key);

          const feeRates = getFeeRates.channels.filter(rate => {
            return channels.find(n => asTxOut(n) === asTxOut(rate));
          });

          const currentPolicies = getPolicies
            .filter(n => !!n)
            .filter(n => channels.find(chan => asTxOut(chan) === asTxOut(n)))
            .map(n => n.policies.find(p => p.public_key === ownKey))
            .filter(n => !!n);

          const baseFeeMillitokens = feeRates
            .map(n => BigInt(n.base_fee_mtokens))
            .reduce((sum, fee) => fee > sum ? fee : sum, BigInt(Number()));

          return channels.map(channel => {
            // Exit early when there is no known policy
            if (!currentPolicies.length) {
              return {
                fee_rate: args.fee_rate,
                transaction_id: channel.transaction_id,
                transaction_vout: channel.transaction_vout,
              };
            }

            return {
              base_fee_mtokens: baseFeeMillitokens.toString(),
              cltv_delta: max(...currentPolicies.map(n => n.cltv_delta)),
              fee_rate: args.fee_rate,
              transaction_id: channel.transaction_id,
              transaction_vout: channel.transaction_vout,
            };
          });
        });

        return asyncEach(flatten(updates), (update, cbk) => {
          return asyncRetry({interval, times}, cbk => {
            return updateChannelFee({
              base_fee_mtokens: update.base_fee_mtokens,
              cltv_delta: update.cltv_delta,
              fee_rate: update.fee_rate,
              from: getPublicKey.public_key,
              lnd: args.lnd,
              transaction_id: update.transaction_id,
              transaction_vout: update.transaction_vout,
            },
            err => {
              if (!!err) {
                args.logger.error(err);

                args.logger.info({
                  next_retry: moment().add(interval, 'ms').calendar(),
                });

                return cbk(err);
              }

              return cbk();
            });
          },
          cbk);
        },
        cbk);
      }],

      // Get final fee rates
      getRates: ['updateFees', ({}, cbk) => {
        return getFeeRates({lnd: args.lnd}, cbk);
      }],

      // Get fee rundown
      fees: [
        'getAliases',
        'getChannels',
        'getPeers',
        'getPolicies',
        'getRates',
        ({getAliases, getChannels, getPeers, getPolicies, getRates}, cbk) =>
      {
        const peersWithFees = getAliases.map(({alias, id}) => {
          const channels = getChannels.channels.filter(channel => {
            return channel.partner_public_key === id;
          });

          const peerRates = getRates.channels.filter(channel => {
            return !!channels.find(rate => {
              if (channel.transaction_id !== rate.transaction_id) {
                return false;
              }

              return channel.transaction_vout === rate.transaction_vout;
            });
          });

          const rate = max(...peerRates.map(n => n.fee_rate));

          return {
            alias: alias || shortKey(id),
            id: id,
            out_fee: !peerRates.length ? noFee : formatFeeRate({rate}).display,
          };
        });

        const rows = []
          .concat([['Peer', 'Out Fee', 'Public Key']])
          .concat(peersWithFees.map(peer => {
            const isChange = getPeers.find(n => n.public_key === peer.id);

            return [
              isChange ? green(peer.alias) : peer.alias,
              isChange ? green(peer.out_fee) : peer.out_fee,
              isChange ? green(peer.id) : peer.id,
            ];
          }));

        return cbk(null, {rows});
      }],
    },
    returnResult({reject, resolve, of: 'fees'}, cbk));
  });
};
