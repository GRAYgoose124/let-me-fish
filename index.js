const path = require('path'),
    fs = require('fs');

const ACTION_DELAY_THROW_ROD   = [1700, 2000],		// [Min, Max] in ms, 1000 ms = 1 sec
      ACTION_DELAY_FISH_START  = [1700, 2000],		// [Min, Max] - the pressing of F button to reel and start the minigame
      ACTION_DELAY_FISH_CATCH  = [2700, 3000],	// [Min, Max] - time to win the fishing minigame and get a fish as prize
      DELAY_BASED_ON_FISH_TIER = true; // tier 4 would get caught 4 sec longer, BAF (tier 11) would get caught 11 sec longer etc

const TEMPLATE_SELLER = [9903, 9906, 1960, 1961];
const TEMPLATE_BANKER = 1962;
const ITEMS_SALAD = [206020, 206040];
const FILET_ID = 204052;

const BAIT_RECIPES = [
    {name: "Bait II", itemId: 206001, recipeId: 204100, wormId: 206006},
    {name: "Bait III", itemId: 206002, recipeId: 204101, wormId: 206007},
    {name: "Bait IV", itemId: 206003, recipeId: 204102, wormId: 206008},
    {name: "Bait V", itemId: 206004, recipeId: 204103, wormId: 206009}
];

const CONTRACT = {
    id: null,
    type: null
}

// let fishingSettings = { // TODO: move to structs and store data to make decisions on.
//     enabled: false,
//     bWaitingForBite: false,
//     bTooManyFish: false, // Whether or not we need to use multiple dismantle contracts.
//     bTriedDismantling: false,
//     bDismantleFish: true,
//     bDismantleFishGold: false,
// }
//
// let playerState = {
//     playerLoc: null,
//     invenItems: [],
//     myGameId: 0n,
//
// }
//
// let fishingState = {
//     rodId: 0,
//     baitId: 0,   // BAIT_RECIPES.find(obj => obj.recipeId === craftId).baitId || wormId
//     craftId: 0,  // BAIT_RECIPES.find(obj => obj.recipeId === craftId).itemId
//     contractId: null,
//     statFishedTiers: {},
//     statFished: 0,
// }

// TODO: Re-add Auto-nego integration -- simply on a nego hook, stop fishing and start after nego max delay. prio-min
// TODO: auto-buy palid for angler tokens prio-min
// TODO: auto sell fillets & golds. prio-mid
// TODO: 10k fish hook -> don't dismantle, sell common fish - prio-high
// TODO: auto salad prio-mid

module.exports = function LetMeFish(mod) {
    const command = mod.command,
        dismantle_contract_type = (mod.majorPatchVersion >= 85 ? 90 : 89),
        craft_contract_type = (mod.majorPatchVersion >= 85 ? 31 : null); // don't know pre-85 value.

    let enabled = false,
        bWaitingForBite = false,
        bTooManyFish = false, // Whether or not we need to use multiple dismantle contracts.
        bTriedDismantling = false,
        bDismantleFish = true,
        bDismantleFishGold = false,
        debugLevel = 4,
        myGameId = 0n,
        statFished = 0,
        statFishedTiers = {},
        hooks = [],
        fishList = [],
        curTier = 0,
        rodId = 0,
        baitId = 0,
        craftId = 0,
        leftArea = 0,
        putinfishes = 0,
        awaiting_dismantling = 0,
        playerLoc = null,
        vContract = null,
        invenItems = [],
        statStarted = null,
        gSettings = {},
        settingsFileName;

    if (!fs.existsSync(path.join(__dirname, './saves'))) {
        fs.mkdirSync(path.join(__dirname, './saves'));
    }

    // Fishing pattern functions
    // branches to use_bait_item
    function check_if_fishing() {
        logMsg('INFO', "check_if_fishing()");
        logMsg('GAME', "Not fishing... No bait used?");
        mod.setTimeout(use_bait_item, 500);
    }

    // branches to craft_bait_start | check_if_fishing
    function throw_rod() {
        logMsg('INFO', "throw_rod()");
        if (baitId && !invenItems.filter((item) => item.id === baitId).length) {
            logMsg('GAME', "No bait found in inventory, crafting...");
            mod.setTimeout(craft_bait_start, rng(ACTION_DELAY_FISH_START) / 4);
        } else if (rodId) {
            logMsg('DEBG', "< C_USE_ITEM.3:rodId=" + rodId, {}, 1);
            mod.toServer('C_USE_ITEM', 3, { // TODO: stop_fishing on failure, get ret code.
                gameId: myGameId,
                id: rodId,
                dbid: 0n, // dbid is sent only when used from inventory, but not from quickslot
                target: 0n,
                amount: 1,
                dest: 0,
                loc: playerLoc.loc,
                w: playerLoc.w,
                unk1: 0,
                unk2: 0,
                unk3: 0,
                unk4: true
            }); // throw the rod!
            mod.clearAllTimeouts();
            mod.setTimeout(check_if_fishing, rng(ACTION_DELAY_FISH_START) + 180000); // 180 sec cuz after dismantling it might take 2+ minutes for a fish to bite
        } else {
            command.message("No rod used.");
            stop_fishing();
        }
    }

    // no branch
    function reel_the_fish() {
        logMsg('INFO', "reel_the_fish()");
        logMsg('DEBG', "< C_START_FISHING_MINIGAME.1", {}, 1);

        mod.toServer("C_START_FISHING_MINIGAME", 1, {counter: 1, unk: 15});
    }

    // branches to throw_rod
    function catch_the_fish() {
        logMsg('INFO', "catch_the_fish()");
        logMsg('DEBG', "< C_END_FISHING_MINIGAME.1", {}, 1);

        mod.toServer("C_END_FISHING_MINIGAME", 1, {counter: 1, unk: 24, success: true});
        statFished++;

        mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD) + 1000);
    }

    // no branch
    function stop_fishing() {
        logMsg('INFO', "stop_fishing()");

        enabled = false
        vContract = null;
        bTooManyFish = false;
        bTriedDismantling = false;
        putinfishes = 0;

        unload();
        mod.clearAllTimeouts();

        if (!bWaitingForBite) {
            let d = new Date();
            let t = d.getTime();
            let timeElapsedMSec = t - statStarted;
            d = new Date(1970, 0, 1); // Epoch
            d.setMilliseconds(timeElapsedMSec);
            let h = addZero(d.getHours());
            let m = addZero(d.getMinutes());
            let s = addZero(d.getSeconds());

            logMsg('GAME', '\nObtained ' + statFished + ' fish.\t\nTime elapsed: ' + (h + ":" + m + ":" + s) + "\t" + Math.round((timeElapsedMSec / statFished) / 1000) + " sec/fish\n\nFish:", {}, 1);
            for (let i in statFishedTiers) {
                logMsg('CONT', 'Tier ' + i + ': ' + statFishedTiers[i], {}, 1);
            }
            console.log("\n")

            statFished = 0;
            statFishedTiers = {};
        } else {
            logMsg('GAME', 'Autofishing disabled.');
        }
    }

    // branches to throw_rod
    function reset_fishing() {
        logMsg('INFO', "reset_fishing()");

        if (vContract) {
            logMsg('DEBG', "< C_CANCEL_CONTRACT.1:vContractId=" + vContract.id, vContract, 1);
            mod.toServer('C_CANCEL_CONTRACT', 1, {
                type: vContract.type,
                id: vContract.id
            });
            vContract = null;
        }
        if (enabled) {
            mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD) + 1000); // lets resume fishing
        }
    }

    // branches to cleanup_by_dismantle | use_bait_item
    function craft_bait_start(chain) {
        logMsg('INFO', "craft_bait_start()");

        if (craftId) {
            let filets = invenItems.find((item) => item.id === 204052);
            let needed = (chain ? 2 : 1) * (15 + ((craftId - 204100) * 5)); // inven gets updated AFTER you send another C_START_PRODUCE
            if (filets && filets.amount >= needed) {  // need one more to trigger "can't craft more bait"
                logMsg('DEBG', "< C_START_PRODUCE.1:craftId=" + craftId, chain, 1);
                mod.toServer('C_START_PRODUCE', 1, {recipe: craftId, unk: 0});
                baitId = BAIT_RECIPES.find(obj => obj.recipeId === craftId).itemId;
            } else if (!bTriedDismantling) {
                bTriedDismantling = true;
                mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_THROW_ROD));
                logMsg('GAME', "You don't have enough fish parts to craft a bait... dismantling fishes to get some");
            } else if (chain || invenItems.filter((item) => item.id === baitId).length) {
                logMsg('GAME', "Crafted few bait items, then ran out of fish parts, fishing...");
                mod.setTimeout(use_bait_item, rng(ACTION_DELAY_FISH_START));
            } else {
                logMsg('GAME', "You don't have enough filets or fish to craft bait. Stopping.");
                stop_fishing();
            }
        } else {
            logMsg('GAME', "You didn't provide a sample craft recipe for bait. Stopping.");
            stop_fishing();
        }
    }

    // branches to throw_rod
    function use_bait_item() {
        logMsg('INFO', "use_bait_item()");

        if (baitId) {
            bTriedDismantling = false;
            logMsg('DEBG', "< C_USE_ITEM.3:baitId=", {"craftbait": craftId, "activebait": baitId}, 1);
            mod.toServer('C_USE_ITEM', 3, {
                gameId: myGameId,
                id: baitId,
                dbid: 0n, // dbid is sent only when used from inventory, but not from quickslot
                target: 0n,
                amount: 1,
                dest: 0,
                loc: playerLoc.loc,
                w: playerLoc.w,
                unk1: 0,
                unk2: 0,
                unk3: 0,
                unk4: true
            });
            mod.setTimeout(throw_rod, rng(ACTION_DELAY_FISH_START));
        } else {
            logMsg('GAME', "No bait.");
            stop_fishing();
        }
    }

    // branches to add_fish_to_dismantler | reset_fishing
    function cleanup_by_dismantle() {
        logMsg('INFO', "cleanup_by_dismantle()");

        if (enabled) {
            if (bDismantleFish || bDismantleFishGold) {
                fishList.length = 0;
                if (bDismantleFish) {
                    fishList = invenItems.filter((item) => item.id >= 206400 && item.id <= 206456);
                }
                if (bDismantleFishGold) {
                    fishList = fishList.concat(invenItems.filter((item) => item.id >= 206500 && item.id <= 206514));
                }

                if (fishList.length > 20) {
                    logMsg('INFO', "Total fish: " + fishList.length);
                    awaiting_dismantling = fishList.length;
                    bTooManyFish = true;
                    while (fishList.length > 20) {
                        fishList.pop();
                    }
                } else {
                    bTooManyFish = false;
                }

                if (fishList.length) {
                    logMsg('GAME', "Dismantling " + fishList.length + " fish.");
                    // duplicate code...really should make a fun cancelContract(type, id);
                    if (vContract !== null && vContract.type !== dismantle_contract_type ) {
                        logMsg('DEBG', "< C_CANCEL_CONTRACT.1:vContractId=" + vContract.id, vContract, 1);
                        mod.toServer('C_CANCEL_CONTRACT', 1, {
                            type: vContract.type,
                            id: vContract.id
                        });
                        vContract = null;
                    }

                    if (vContract === null) {
                        mod.toServer('C_REQUEST_CONTRACT', 1, {type: dismantle_contract_type});
                        logMsg('DEBG', "< C_REQUEST_CONTRACT.1:dismantle=?", {}, 1);
                    }

                    mod.setTimeout(add_fish_to_dismantler, (rng(ACTION_DELAY_FISH_START) + 10000));
                } else if (awaiting_dismantling <= 0) {
                    logMsg('GAME', "Cannot dismantle anything.");
                    stop_fishing();
                } else {
                    let log_str = awaiting_dismantling.concat(" fish awaiting dismantling but couldn't be found in inventory.\n",
                        "inventory: (reported empty of fish)\n", invenItems, "\nfish array (reported empty): \n", fishList);
                    logMsg('GAME', log_str);

                    awaiting_dismantling = 0;
                    mod.setTimeout(reset_fishing, rng(ACTION_DELAY_FISH_START)); // cancel contract & throw the rod
                }

            } else {
                logMsg('GAME', "Auto-dismantle is disabled. Unable to clean-up. Stopping.");
                stop_fishing();
            }
        }
    }

    // branches to add_fish_to_dismantler | start_dismantle | cleanup_by_dismantle
    function add_fish_to_dismantler() {
        logMsg('INFO', "add_fish_to_dismantler()");

        if (vContract !== null) {
            if (vContract.type === dismantle_contract_type) {
                const fish = fishList.pop();
                if (fish) {
                    logMsg('DEBG', "< C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1=" + vContract.id, fish, 1);
                    mod.toServer('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, {
                        contract: vContract.id,
                        dbid: fish.dbid,
                        itemid: fish.id,
                        amount: 1
                    });
                    putinfishes++;
                }
                if (fishList.length) {
                    mod.setTimeout(add_fish_to_dismantler, (rng(ACTION_DELAY_FISH_START) / 4));
                } else {
                    mod.setTimeout(start_dismantle, (rng(ACTION_DELAY_FISH_START) / 2));
                }
            } else {
                logMsg('GAME', "No dismantle contract found, retrying.");
                mod.setTimeout(cleanup_by_dismantle, (rng(ACTION_DELAY_FISH_START)+1000));
            }
        }
    }

    //branches to dismantle_batch
    function start_dismantle() {
        logMsg('INFO', "start_dismantle()");

        logMsg('DEBG', "< C_RQ_COMMIT_DECOMPOSITION_CONTRACT.1:vContractId=" + vContract.id, vContract, 1);
        mod.toServer('C_RQ_COMMIT_DECOMPOSITION_CONTRACT', 1, {contract: vContract.id});

        mod.setTimeout(dismantle_batch, 1925);
    }

    // branches to cleanup_by_dismantle | reset_fishing
    function dismantle_batch() {
        logMsg('INFO', "dismantle_batch()", fishList, 1);

        awaiting_dismantling = -putinfishes;
        putinfishes = 0;

        mod.toServer('C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION', 1, {contract: vContract.id}); // Maybe proc at same time as C_RQ_COMMIT??
        logMsg('DEBG', "< C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION.1:vContractId=" + vContract.id, fishList, 1);

        if (bTooManyFish) {
            mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START) + 5500);
        } else {
            mod.setTimeout(reset_fishing, rng(ACTION_DELAY_FISH_START));
        }
    }

    // Region Permanent Hooks
    mod.hook('C_PLAYER_LOCATION', 5, event => {
        playerLoc = event;
    });

    mod.hook('S_LOGIN', mod.majorPatchVersion >= 86 ? 14 : 13, event => {
        myGameId = event.gameId;
        invenItems = [];
        rodId = null;
        vContract = null;
        putinfishes = 0;
        settingsFileName = `./saves/${event.name}-${event.serverId}.json`;
        let lSettings = loadSettings();
        if (!Object.keys(lSettings).length) {
            baitId = 0;
            craftId = 0;
            bDismantleFish = true;
            bDismantleFishGold = false;
        } else {
            bDismantleFish = lSettings.bDismantleFish || true;
            bDismantleFishGold = lSettings.bDismantleFishGold || false;
            craftId = lSettings.craftId || 0;
            let found = BAIT_RECIPES.find(obj => obj.recipeId === craftId);
            if (found) {
                baitId = found.itemId;
            } else {
                logMsg('GAME', "Your config file is corrupted, the bait recipe id is invalid.");
            }
        }
    });

    // Main fishing pattern entry
    command.add(['fish', '!fish', 'f'], {
        //branches to start | stop_fishing
        $none() {
            enabled = !enabled;
            logMsg('GAME', `Auto-fishing is now ${enabled ? "en" : "dis"}abled.`);
            if (enabled) {
                start();
                bWaitingForBite = true;
                if (!craftId) {
                    command.message("Select a bait to auto-craft in Processing..");
                    command.message("Activate some bait and throw your rod to auto-fish.");
                } else { // TODO: Save bait/rod and auto-start on command.
                    logMsg('CONT', "Autocraft recipe: ".concat((craftId ? craftId : "none"), "\n\tBait:\t", (baitId ? baitId : "none"),
                        "\n\tAutoDismantle CF=" + bDismantleFish + ", GF=" + bDismantleFishGold));
                }
                command.message("Use some bait and throw your rod.");
            } else {
                stop_fishing();
            }
        },
        dismantle() {
            bDismantleFish = !bDismantleFish;
            logMsg('GAME', `Common Fish dismantling is ${bDismantleFish ? "en" : "dis"}abled.`);
        },
        gold() {
            bDismantleFishGold = !bDismantleFishGold;
            logMsg('GAME', `Gold Fish dismantling is ${bDismantleFishGold ? "en" : "dis"}abled.`);
        },
        reset() {
            bDismantleFish = true;
            bDismantleFishGold = false;
            craftId = 0;
            baitId = 0;
            logMsg('GAME', "Craft recipe, bait to use, and fish to dismantle reset to defaults.");
        },
        list() {
            logMsg('CONT', "Autocraft recipe: ".concat((craftId ? craftId : "none"), "\n\tBait: \n\t", (baitId ? baitId : "none"),
                "\n\tAutoDismantle CF=" + bDismantleFish + ", GF=" + bDismantleFishGold));
        },
        save() {
            logMsg('GAME', "Saved settings.");
            gSettings.bDismantleFish = bDismantleFish;
            gSettings.bDismantleFishGold = bDismantleFishGold;
            gSettings.craftId = craftId;
            saveSettings(gSettings);
        },
        load() {
            logMsg('GAME', "Loaded settings.");
            gSettings = loadSettings();
            bDismantleFish = gSettings.bDismantleFish;
            bDismantleFishGold = gSettings.bDismantleFishGold;
            craftId = gSettings.craftId;
            let found = BAIT_RECIPES.find(obj => obj.recipeId === craftId);
            if (found) {
                baitId = found.itemId;
            } else {
                logMsg('GAME', "Load failed, couldn't find bait.");
            }
        },
        $default() {
            logMsg('GAME', 'Invalid command.')
        }
    });

    function start() {
        if (hooks.length) return; // edge case where mod isn't loaded properly?

        logMsg('INFO', "start() | Fish sequence starting...");

        //Check the server response to C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1
        Hook('S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, event => {
            if (vContract === null) return;

            if (vContract.type === dismantle_contract_type) {
                logMsg('INFO', "> S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1:success=" + event.success, event, 1);
            }
        });

        // branches to catch_the_fish AKA send(C_END_FISHING_MINIGAME.1)
        Hook('S_START_FISHING_MINIGAME', 1, event => {
            if (!enabled || bWaitingForBite) return;

            if (myGameId === event.gameId) { // TODO: update to use mod.game lib
                logMsg('INFO', "> S_START_FISHING_MINIGAME.1", event, 1);
                let fishTier = event.level;
                rodId = event.rodId;

                if (DELAY_BASED_ON_FISH_TIER) {
                    curTier = fishTier;
                }
                statFishedTiers[fishTier] = statFishedTiers[fishTier] ? statFishedTiers[fishTier] + 1 : 1;

                if (fishTier < 11) {
                    logMsg('GAME', "Catching tier ".concat(fishTier, " fish. Total: ", statFished + 1), event);
                } else {
                    logMsg('GAME', "Catching a Goldfish!");
                }

                mod.setTimeout(catch_the_fish, (rng(ACTION_DELAY_FISH_CATCH) + (curTier * 100)));
                return false; // Hide the minigame.
            }
        });

        // branches to reel_the_fish
        Hook('S_FISHING_BITE', 1, event => {
            if (!enabled) return;

            if (myGameId === event.gameId) {
                logMsg('DEBG', "> S_FISHING_BITE.1", event, 1);
                mod.clearAllTimeouts();
                mod.setTimeout(reel_the_fish, rng(ACTION_DELAY_FISH_START));
                leftArea = 0;
                if (bWaitingForBite) {
                    bWaitingForBite = false;
                    rodId = event.rodId;
                    let d = new Date();
                    statStarted = d.getTime();
                    logMsg('GAME', "Rod set to: " + rodId);
                    if (!craftId) {
                        logMsg('GAME', "No bait craft recipe, cannot autocraft.");
                    }
                    if (!bDismantleFish && !bDismantleFishGold) {
                        logMsg('GAME', "Fish auto-dismantling is off. Cannot auto-dismantle.");
                    }
                    logMsg('GAME', "Auto-fishing on.");
                }

                return false; // Hide minigame
            }
        });

        // branches to cleanup_by_dismantle
        if (mod.majorPatchVersion >= 85) {
            let invenItemsBuffer = [];
            let invenFirst = true;
            Hook('S_ITEMLIST', mod.majorPatchVersion >= 87 ? 3 : 2, event => {
                if (!enabled) return;

                if (event.container !== 14) {
                    invenItemsBuffer = event.first ? event.items : invenItemsBuffer.concat(event.items);
                    if (!event.more) {
                        if (invenFirst) {
                            invenFirst = false;
                            invenItems = invenItemsBuffer;
                        } else {
                            invenItems = invenItems.concat(invenItemsBuffer);
                        }
                    }
                }

                // if (!event.more) { console.log("\t\t" + invenItemsBuffer.length + " items in container " + event.container + ", pocket " + event.pocket); }
                if (event.lastInBatch && !event.more) {
                    invenFirst = true;
                    if (bTooManyFish && putinfishes === 0) {
                        mod.clearAllTimeouts();
                        mod.setTimeout(() => {
                            logMsg('GAME', "Dismantling next batch.");
                        }, ACTION_DELAY_FISH_START[0] / 3);
                        mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START) / 3);
                    }
                }
            });
        } else {
            Hook('S_INVEN', 19, event => {
                if (!enabled) return;

                invenItems = event.first ? event.items : invenItems.concat(event.items);
                if (bTooManyFish && putinfishes === 0 && !event.more) {
                    mod.clearAllTimeouts();
                    mod.setTimeout(function () {
                        logMsg('GAME', "Inventory fully updated, starting dismantling of the next batch of fish");
                    }, ACTION_DELAY_FISH_START[0] / 3);
                    mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START) / 3);
                }
            });
        }

        // v
        Hook('S_REQUEST_CONTRACT', 1, event => {
            logMsg('DEBG', '> S_REQUEST_CONTRACT.1:event.type=' + event.type, event, 1)
            if (!enabled || bWaitingForBite || event.senderId !== myGameId) return;

            vContract = event;

            if (event.type === dismantle_contract_type) {
                logMsg('DEBG', "Dismantle:ContractId=" + event.id, event, 2);

                mod.clearAllTimeouts();
                mod.setTimeout(add_fish_to_dismantler, (rng(ACTION_DELAY_FISH_START) / 2));
            } else if (event.type === craft_contract_type) {
                logMsg('DEBG', "Craft:ContractId=" + event.id, event, 2);
            } else {
                vContract = null;
            }
        });

        // branches to throw_rod because the loop expects to cancel a dismantle contract, this needs to be refactored.
        Hook('S_CANCEL_CONTRACT', 1, event => {
            if (vContract === null) return;
            if (!enabled || bWaitingForBite || event.id !== vContract.id || event.senderId !== myGameId) return;


            if (event.type === dismantle_contract_type || event.type === craft_contract_type) {
                logMsg("DEBG", "> S_CANCEL_CONTRACT.2:id=" + event.id, event, 1);
                vContract = null;
                logMsg('GAME', "Contract for dismantling cancelled (not by this mod), retrying fishing sequence...", event);
                mod.clearAllTimeouts();
                mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD));
            }
        });

        // bait craft
        Hook('C_START_PRODUCE', 1, event => {
            if (!bWaitingForBite) return;
            logMsg('DEBG', "< C_START_PRODUCE.1:recipeId=" + event.recipe, event, 1);

            craftId = event.recipe;
            let found = BAIT_RECIPES.find(obj => obj.recipeId === event.recipe);
            if (found) {
                baitId = found.itemId;
                logMsg('GAME', "Crafting bait recipe: " + event.recipe + ", bait: " + baitId, event);
            } else {
                logMsg('GAME', "Craft id is not a bait recipe.", event);
            }
        });

        Hook('S_END_PRODUCE', 1, event => {
            if (!enabled || bWaitingForBite) return;
            if (event.success) {
                logMsg("DEBG", "> S_END_PRODUCE.1:bCraftMore=True", event, 1)
                craft_bait_start(true);
            }
        });

        // branches to craft_bait_start | use_bait_item | cleanup_by_dismantle | throw_rod | stop_fishing
        Hook('S_SYSTEM_MESSAGE', 1, event => {
            if (!enabled || bWaitingForBite) return;
            const msg = mod.parseSystemMessage(event.message);

            if (msg.id === 'SMT_CANNOT_FISHING_NON_BAIT') {
                logMsg('GAME', "Out of bait, crafting...");
                mod.clearAllTimeouts();
                mod.setTimeout(craft_bait_start, rng(ACTION_DELAY_FISH_START));
            } else if (msg.id === 'SMT_ITEM_CANT_POSSESS_MORE') {
                logMsg('DEBG', "> SMT_CAN'T_POSSESS", event, 1)
                if (vContract) {
                    mod.clearAllTimeouts();

                    if (vContract.type === dismantle_contract_type) {
                        logMsg('GAME', "You have reached the 10k dismantled fish parts limit, stopping."); // TODO: Auto-sell
                        if (putinfishes) {
                            bTooManyFish = false;
                            enabled = false;
                            start_dismantle();
                            mod.setTimeout(stop_fishing, (rng(ACTION_DELAY_FISH_START) + 4000));
                        } else {
                            stop_fishing();
                        }
                    } else if (vContract.type === craft_contract_type) {
                        let itemId = Number(msg.tokens.ItemName.substr(6));
                        if (itemId >= 206006 && itemId <= 206009) {
                            logMsg('GAME', "Max bait crafted, restarting fishing with worms.");
                            baitId = itemId;
                        } else {
                            logMsg('GAME', "Max bait crafted, restarting fishing.");
                        }
                        mod.setTimeout(use_bait_item, rng(ACTION_DELAY_FISH_START));
                    }
                } else {
                    logMsg("If you got here, I'm not catching all the contracts I start!")
                }
            } else if (msg.id === 'SMT_CANNOT_FISHING_FULL_INVEN') { // auto-dismantle entry.
                logMsg('GAME', "Inventory full, dismantling.");
                mod.clearAllTimeouts();
                mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START) + 1500);
            } else if (msg.id === 'SMT_CANNOT_FISHING_NON_AREA') {
                logMsg('GAME', "Fishing area changed, retrying.");
                mod.clearAllTimeouts();
                leftArea++;
                if (leftArea < 7) {
                    mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD));
                } else {
                    stop_fishing();
                    logMsg('GAME', "Can't seem to fish in this area, stopping.");
                }
            } else if (msg.id === 'SMT_FISHING_RESULT_CANCLE') {
                logMsg('GAME', "Fishing cancelled, retrying.");
                mod.clearAllTimeouts();
                mod.setTimeout(throw_rod, rng(ACTION_DELAY_FISH_START));
            } else if (msg.id === 'SMT_YOU_ARE_BUSY' && vContract !== null) {
                logMsg('GAME', "SMT_YOU_ARE_BUSY, retrying.");
                mod.clearAllTimeouts();
                mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD) + 3000);
            } else if (msg.id === 'SMT_CANNOT_USE_ITEM_WHILE_CONTRACT') {
                logMsg('GAME', "In a contract, retrying.");
                mod.clearAllTimeouts();
                mod.setTimeout(throw_rod, (rng(ACTION_DELAY_THROW_ROD) + 3000));
            }
        });

        // Utility hooks
         // Anti-GM
        Hook('S_SPAWN_USER', 15, event => {
            if (event.gm && enabled) {
                logMsg('GAME', "GM near you, temporarily stopping.", event);
                stop_fishing();
                enabled = true;
                mod.setTimeout(reset_fishing, rng([60000, 180000]));
            }
        });

          // Stop fishing on tp.
        Hook('S_LOAD_TOPO', 3, () => {
            if (enabled) {
                stop_fishing();
                logMsg('GAME', "Teleported. AF stopped.");
            }
        });

        // Nego hook
        // AFK deny hook
    }

    // Helpers
    function saveSettings(obj) {
        if (Object.keys(obj).length) {
            try {
                fs.writeFileSync(path.join(__dirname, settingsFileName), JSON.stringify(obj, null, "\t"));
            } catch (err) {
                logMsg('ERRO', "Error saving settings ", err);
                return false;
            }
        }
    }

    function loadSettings() {
        try {
            return JSON.parse(fs.readFileSync(path.join(__dirname, settingsFileName), "utf8"));
        } catch (err) {
            logMsg('ERRO', "Error loading settings ", err);
        }
    }

    function addZero(i) {
        if (i < 10) {
            i = "0" + i;
        }
        return i;
    }

    function rng([min, max]) {
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    // TODO: game and debug console independent.  Clean and fix.
    function logMsg(level, str, data, indent) {
        var lvl = null;
        var logStr = "";

        if (typeof indent !== 'undefined') {
            logStr = "\t".repeat(indent);
        }

        switch (level) {
            case 'GAME':
            case 'CONT':
                for (let part of str.replace('\t', '').split('\n')) {
                    command.message(part);
                }
                if (level === 'CONT') {
                    console.log(logStr + str);
                    return;
                }
                lvl = 0
                break
            case 'INFO':
                lvl = 1;
                break
            case 'ERRO':
                lvl = 2;
                break
            case 'WARN':
                lvl = 3;
                break
            case 'DEBG':
                lvl = 4;
                break

            default:
                return
        }

        if (debugLevel >= lvl) {
            var dat = {};

            try {
                if (typeof data !== "undefined" && data.constructor === Object && data.keys !== "undefined") {
                    dat = jsonify(data);
                }
                if (dat.length) {
                    logStr = "[".concat(level, "]: ", logStr, str, "\n", logStr, "\t", debugLevel>=4?JSON.stringify(dat, null, "    ".repeat(indent)):"");
                } else {
                    logStr = "[".concat(level, "]: ", logStr, str);
                }
            } catch (e) {
                logStr = "[JSON] ".concat(logStr, '\nErr: ', e, '\nstr: ', str, '\ndata: ', data);
            }

            console.log(logStr);
        }
    }

    function jsonify(d) {
        var dat = {};

        for (let key in d) {
            switch(typeof d[key]) {
                case "bigint": dat[key] = d[key].toString(16); break
                default: dat[key] = d[key]; break
            }
        }

        return dat;
    }

    function unload() {
        if (hooks.length) {
            for (let h of hooks) mod.unhook(h);
            hooks = [];
        }
    }

    function Hook() {
        hooks.push(mod.hook(...arguments));
    }
}
