const ACTION_DELAY_THROW_ROD = [2000, 3000],		// [Min, Max] in ms, 1000 ms = 1 sec
    ACTION_DELAY_FISH_START = [2000, 2500],		// [Min, Max] - the pressing of F button to reel and start the minigame
    ACTION_DELAY_FISH_CATCH = [2000, 3500],	// [Min, Max] - time to win the fishing minigame and get a fish as prize
    DELAY_BASED_ON_FISH_TIER = false; // tier 4 would get caught 4 sec longer, BAF (tier 11) would get caught 11 sec longer etc

const path = require('path'),
    fs = require('fs');

const BAIT_RECIPES = [
    {name: "Bait II", itemId: 206001, recipeId: 204100, wormId: 206006},
    {name: "Bait III", itemId: 206002, recipeId: 204101, wormId: 206007},
    {name: "Bait IV", itemId: 206003, recipeId: 204102, wormId: 206008},
    {name: "Bait V", itemId: 206004, recipeId: 204103, wormId: 206009}
];

module.exports = function LetMeFish(mod) {
    const command = mod.command,
        dismantle_contract_type = (mod.majorPatchVersion >= 85 ? 90 : 89);

    let enabled = false,
        bWaitingForBite = false,
        bTooManyFish = false, // Whether or not we need to use multiple dismantle contracts.
        bTriedDismantling = false,
        debugLevel = 0,
        myGameId = 0n,
        statFished = 0,
        statFishedTiers = {},
        hooks = [],
        bDismantleFish = true,
        bDismantleFishGold = false,
        fishList = [],
        curTier = 0,
        rodId = 0,
        baitId = 0,
        craftId = 0,
        leftArea = 0,
        putinfishes = 0,
        awaiting_dismantling = 0,
        playerLoc = null,
        vContractId = null,
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
        command.message("Not fishing... No bait used?");
        mod.setTimeout(use_bait_item, 500);
    }

    // branches to craft_bait_start | check_if_fishing
    function throw_rod() {
        logMsg('INFO', "throw_rod()");
        if (baitId && !invenItems.filter((item) => item.id === baitId).length) {
            command.message("No bait found in inventory, crafting...");
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
        vContractId = null;
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

            logMsg('GAME', '\nObtained ' + statFished + ' fish.\t\nTime elapsed: ' + (h + ":" + m + ":" + s) + "\t" + Math.round((timeElapsedMSec / statFished) / 1000) + " sec/fish\n\nFish:");
            for (let i in statFishedTiers) {
                logMsg('GAME', 'Tier ' + i + ': ' + statFishedTiers[i], {}, 1);
            }
            console.log("\n")

            statFished = 0;
            statFishedTiers = {};
        } else {
            command.message('Autofishing disabled.');
        }
    }

    // branches to throw_rod
    function reset_fishing() {
        logMsg('INFO', "reset_fishing()");

        if (vContractId) {
            logMsg('DEBG', "< C_CANCEL_CONTRACT.1:vContractId=" + vContractId, {}, 1);
            mod.toServer('C_CANCEL_CONTRACT', 1, {
                type: dismantle_contract_type,
                id: vContractId
            });
            vContractId = null;
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
                command.message("You don't have enough fish parts to craft a bait... dismantling fishes to get some");
            } else if (chain || invenItems.filter((item) => item.id === baitId).length) {
                command.message("Crafted few bait items, then ran out of fish parts, fishing...");
                mod.setTimeout(use_bait_item, rng(ACTION_DELAY_FISH_START));
            } else {
                command.message("You don't have enough filets or fish to craft bait. Stopping.");
                stop_fishing();
            }
        } else {
            command.message("You didn't provide a sample craft recipe for bait. Stopping.");
            stop_fishing();
        }
    }

    // branches to throw_rod
    function use_bait_item() {
        logMsg('INFO', "use_bait_item()");

        if (baitId) {
            bTriedDismantling = false;
            logMsg('DEBG', "< C_USE_ITEM.3:baitId", {}, 1);
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
            command.message("No bait.");
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
                    if (!vContractId) {
                        mod.toServer('C_REQUEST_CONTRACT', 1, {type: dismantle_contract_type});
                        logMsg('DEBG', "< C_REQUEST_CONTRACT.1:dismantle=?", {}, 1);
                    }
                    mod.setTimeout(add_fish_to_dismantler, (rng(ACTION_DELAY_FISH_START) + 15000));
                } else if (awaiting_dismantling <= 0) {
                    command.message("Cannot dismantle anything.");
                    stop_fishing();
                } else {
                    console.log(awaiting_dismantling + " fish awaiting dismantling but couldn't be found in inventory.");
                    console.log("inventory: (reported empty of fish)");
                    console.log(invenItems);
                    console.log("fish array (reported empty): ");
                    console.log(fishList);
                    awaiting_dismantling = 0;
                    mod.setTimeout(reset_fishing, rng(ACTION_DELAY_FISH_START)); // cancel contract & throw the rod
                }

            } else {
                logMsg('GAME', "Auto-dismamtle is disabled. Unable to clean-up. Stopping.");
                stop_fishing();
            }
        }
    }

    // branches to add_fish_to_dismantler | start_dismantle | cleanup_by_dismantle
    function add_fish_to_dismantler() {
        logMsg('INFO', "add_fish_to_dismantler()");

        if (vContractId) {
            const fish = fishList.pop();
            if (fish) {
                // command.message("Requesting dismantle of: " + fish.id + ", " + fish.dbid);
                logMsg('DEBG', "< C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1=" + vContractId, fish, 1);
                mod.toServer('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, {
                    contract: vContractId,
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
            logMsg('GAME', "No contract found, retrying.");
            mod.setTimeout(cleanup_by_dismantle, (rng(ACTION_DELAY_FISH_START)+1500));
        }
    }

    //branches to dismantle_batch
    function start_dismantle() {
        logMsg('INFO', "start_dismantle()");

        logMsg('DEBG', "< C_RQ_COMMIT_DECOMPOSITION_CONTRACT.1:vContractId=" + vContractId, {}, 1);
        mod.toServer('C_RQ_COMMIT_DECOMPOSITION_CONTRACT', 1, {contract: vContractId});

        mod.setTimeout(dismantle_batch, 1925);
    }

    // branches to cleanup_by_dismantle | reset_fishing
    function dismantle_batch() {
        logMsg('INFO', "dismantle_batch()", fishList, 1);

        awaiting_dismantling = -putinfishes;
        putinfishes = 0;

        mod.toServer('C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION', 1, {contract: vContractId});
        logMsg('DEBG', "< C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION.1:vContractId=" + vContractId, fishList, 1);

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
        vContractId = null;
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
                command.message("Your config file is corrupted, the bait recipe id is invalid.");
            }
        }
    });

    // Main fishing pattern entry
    command.add(['fish', '!fish', 'f'], {
        //branches to start | stop_fishing
        $none() {
            enabled = !enabled;
            command.message(`Auto-fishing is now ${enabled ? "en" : "dis"}abled.`);
            if (enabled) {
                start();
                bWaitingForBite = true;
                if (!craftId) {
                    command.message("Select a bait to auto-craft in Processing..");
                    command.message("Activate some bait and throw your rod to auto-fish.");
                } else { // TODO: Save bait/rod and auto-start on command.
                    this.list()
                }
                command.message("Throw your rod.");
            } else {
                stop_fishing();
            }
        },
        dismantle() {
            bDismantleFish = !bDismantleFish;
            command.message(`Common Fish dismantling is ${bDismantleFish ? "en" : "dis"}abled.`);
        },
        gold() {
            bDismantleFishGold = !bDismantleFishGold;
            command.message(`Gold Fish dismantling is ${bDismantleFishGold ? "en" : "dis"}abled.`);
        },
        reset() {
            bDismantleFish = true;
            bDismantleFishGold = false;
            craftId = 0;
            baitId = 0;
            command.message("Craft recipe, bait to use, and fish to dismantle reset to defaults.");
        },
        list() {
            command.message("Autocraft recipe: " + (craftId ? craftId : "none"));
            command.message("Bait: " + (baitId ? baitId : "none"));
            command.message("AutoDismantle CF=" + bDismantleFish + ", GF=" + bDismantleFishGold);
        },
        save() {
            command.message("Saved.");
            gSettings.bDismantleFish = bDismantleFish;
            gSettings.bDismantleFishGold = bDismantleFishGold;
            gSettings.craftId = craftId;
            saveSettings(gSettings);
        },
        load() {
            command.message("Loaded.");
            gSettings = loadSettings();
            bDismantleFish = gSettings.bDismantleFish;
            bDismantleFishGold = gSettings.bDismantleFishGold;
            craftId = gSettings.craftId;
            let found = BAIT_RECIPES.find(obj => obj.recipeId === craftId);
            if (found) {
                baitId = found.itemId;
            } else {
                command.message("Load failed, couldn't find bait.");
            }
        },
        $default() {
            command.message('Invalid command.')
        }
    });

    function start() {
        if (hooks.length) return; // edge case where mod isn't loaded properly?

        logMsg('INFO', "start() | Fish sequence starting...");

        //Check the server response to C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1
        Hook('S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, event => {
            logMsg('INFO', "> S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1:success=" + event.success, event, 1);
        })

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

                mod.setTimeout(catch_the_fish, (rng(ACTION_DELAY_FISH_CATCH) + (curTier * 1000)));
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
                    command.message("Rod set to: " + rodId);
                    if (!craftId) {
                        command.message("No bait craft recipe, cannot autocraft.");
                    }
                    if (!bDismantleFish && !bDismantleFishGold) {
                        command.message("Fish auto-dismantling is off. Cannot auto-dismantle.");
                    }
                    command.message("Auto-fishing on.");
                }

                return false; // Hide minigame
            }
        });

        // Stop fishing on tp.
        Hook('S_LOAD_TOPO', 3, () => {
            if (enabled) {
                stop_fishing();
                command.message("Teleported. AF stopped.");
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
                            command.message("Dismantling next batch.");
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
                        command.message("Inventory fully updated, starting dismantling of the next batch of fish");
                    }, ACTION_DELAY_FISH_START[0] / 3);
                    mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START) / 3);
                }
            });
        }

        // branches to add_fish_to_dismantler
        Hook('S_REQUEST_CONTRACT', 1, event => {
            logMsg('DEBG', '> S_REQUEST_CONTRACT.1:event.type=' + event.type, event, 1)
            if (!enabled || bWaitingForBite || event.type !== dismantle_contract_type || event.senderId !== myGameId) return;
            logMsg('DEBG', "Dismantle:ContractId=" + event.id, event, 2);

            vContractId = event.id;

            mod.clearAllTimeouts();
            mod.setTimeout(add_fish_to_dismantler, (rng(ACTION_DELAY_FISH_START) / 2));
        });

        // branches to throw_rod
        Hook('S_CANCEL_CONTRACT', 1, event => {
            if (!enabled || bWaitingForBite || event.type !== dismantle_contract_type || event.id !== vContractId || event.senderId !== myGameId) return;
            logMsg("DEBG", "> S_CANCEL_CONTRACT.2:id=" + event.id, event, 1);

            vContractId = null;
            logMsg('GAME', "Contract for dismantling cancelled (not by this mod), retrying fishing sequence...", event);
            mod.clearAllTimeouts();
            mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD));
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
            logMsg("DEBG", "> S_END_PRODUCE.1:bCraftMore=True", event, 1)

            if (event.success) {
                craft_bait_start(true);
            }
        });

        // branches to craft_bait_start | use_bait_item | cleanup_by_dismantle | throw_rod | stop_fishing
        Hook('S_SYSTEM_MESSAGE', 1, event => {
            if (!enabled || bWaitingForBite) return;
            const msg = mod.parseSystemMessage(event.message);

            if (msg.id === 'SMT_CANNOT_FISHING_NON_BAIT') {
                command.message("Out of bait, crafting...");
                mod.clearAllTimeouts();
                mod.setTimeout(craft_bait_start, rng(ACTION_DELAY_FISH_START));
            } else if (msg.id === 'SMT_ITEM_CANT_POSSESS_MORE') {
                if (!vContractId) {
                    mod.clearAllTimeouts();
                    let itemId = Number(msg.tokens.ItemName.substr(6));
                    if (itemId >= 206006 && itemId <= 206009) {
                        command.message("Max bait crafted, restarting fishing with worms.");
                        baitId = itemId;
                    } else {
                        command.message("Max bait crafted, restarting fishing.");
                    }
                    mod.setTimeout(use_bait_item, rng(ACTION_DELAY_FISH_START));
                } else {
                    command.message("You have reached the 10k dismantled fish parts limit, stopping.");
                    mod.clearAllTimeouts();
                    if (putinfishes) {
                        bTooManyFish = false;
                        enabled = false;
                        start_dismantle();
                        setTimeout(stop_fishing, (rng(ACTION_DELAY_FISH_START) + 4000));
                    } else {
                        stop_fishing();
                    }
                }
            } else if (msg.id === 'SMT_CANNOT_FISHING_FULL_INVEN') { // auto-dismantle entry.
                console.log("Inventory full, dismantling.");
                mod.clearAllTimeouts();
                mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START) + 1500);
            } else if (msg.id === 'SMT_CANNOT_FISHING_NON_AREA') {
                console.log("Fishing area changed, retrying.");
                mod.clearAllTimeouts();
                leftArea++;
                if (leftArea < 7) {
                    mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD));
                } else {
                    stop_fishing();
                    command.message("Casn't seem to fish in this area, stopping.");
                }
            } else if (msg.id === 'SMT_FISHING_RESULT_CANCLE') {
                console.log("Fishing cancelled, retrying.");
                mod.clearAllTimeouts();
                mod.setTimeout(throw_rod, rng(ACTION_DELAY_FISH_START));
            } else if (msg.id === 'SMT_YOU_ARE_BUSY' && !vContractId) {
                console.log("SMT_YOU_ARE_BUSY, retrying.");
                mod.clearAllTimeouts();
                mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD) + 3000);
            } else if (msg.id === 'SMT_CANNOT_USE_ITEM_WHILE_CONTRACT') {
                console.log("In a contract, retrying.");
                mod.clearAllTimeouts();
                mod.setTimeout(throw_rod, (rng(ACTION_DELAY_THROW_ROD) + 3000));
            }
        });

        // Anti-GM
        Hook('S_SPAWN_USER', 15, event => {
            if (event.gm && enabled) {
                logMsg('GAME', "GM near you, temporarily stopping.", event);

                stop_fishing();

                enabled = true;
                mod.setTimeout(reset_fishing, rng([60000, 180000]));
            }
        });
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
        switch (level) {
            case 'GAME': {
                for (let part of str.replace('\t', '').split('\n')) {
                    command.message(part);
                }
                lvl = 0;
                break
            }
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
            var logStr = "";
            var dat = {};

            if (typeof data !== 'undefined') {
                for (let entry in Object.entries(data)) {
                    if (typeof entry[1] === BigInt) {
                        dat[entry[0]] = entry[0]
                    } else {
                        dat[entry[0]] = entry[1]
                    }
                }
            }

            if (typeof indent !== 'undefined') {
                logStr = "\t".repeat(indent);
            }

            try {
                if (dat.length) {
                    logStr = "[".concat(level, "]: ", logStr, str, "\n", logStr, "\t", debugLevel>=4?JSON.stringify(dat, null, "    ".repeat(indent)):"");
                } else {
                    logStr = "[".concat(level, "]: ", logStr, str);
                }
            } catch (e) {
                logStr = "[JSON] ".concat(logStr, e, '\n', str);
            }
            console.log(logStr);
        }
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
