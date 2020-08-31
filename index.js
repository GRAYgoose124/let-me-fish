const	ACTION_DELAY_THROW_ROD	= [2000, 3000],		// [Min, Max] in ms, 1000 ms = 1 sec
	  	ACTION_DELAY_FISH_START	= [1000, 2000],		// [Min, Max] - the pressing of F button to reel and start the minigame
	  	ACTION_DELAY_FISH_CATCH	= [2000, 2500],	// [Min, Max] - time to win the fishing minigame and get a fish as prize
		  DELAY_BASED_ON_FISH_TIER = false; // tier 4 would get caught 4 sec longer, BAF (tier 11) would get caught 11 sec longer etc

const path = require('path'),
		    fs = require('fs');

const BAIT_RECIPES = [
	{name: "Bait II",	itemId: 206001, recipeId: 204100, wormId: 206006},
	{name: "Bait III",	itemId: 206002, recipeId: 204101, wormId: 206007},
	{name: "Bait IV",	itemId: 206003, recipeId: 204102, wormId: 206008},
	{name: "Bait V",	itemId: 206004, recipeId: 204103, wormId: 206009}
];

module.exports = function LetMeFish(mod) {
	const command = mod.command,
			  notifier = mod.manager.isLoaded('notifier') ? ( mod.require ? mod.require.notifier : require('tera-notifier')(mod) ) : false,
			  dismantle_contract_type = (mod.majorPatchVersion >= 85 ? 90 : 89);

	let enabled = false,
		bWaitingForBite = false,
		bTooManyFish = false, // Whether or not we need to use multiple dismantle contracts.
		bTriedDismantling = false,
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

	if (!fs.existsSync(path.join(__dirname, './saves'))){	fs.mkdirSync(path.join(__dirname, './saves'));	}

	command.add(['fish', '!fish'], {
		//branches to start | stop_fishing
		$none() {
			enabled = !enabled;
			command.message(`Autofishing is now ${enabled ? "en" : "dis"}abled:`);
			if (enabled) {
				start();
				bWaitingForBite = true;
				if (!craftId) { command.message("Select a bait.");	}
				command.message("Throw your rod.");
			}	else {
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
			if (found){
				baitId = found.itemId;
			} else {
				command.message("Load failed, couldn't find bait.");
			}
		},
		$default() {
			command.message('Invalid command.')
		}
	});

	// branches to use_bait_item
	function check_if_fishing()	{
		console.log("check_if_fishing()");
		command.message("Not fishing... No bait used?");
		mod.setTimeout(use_bait_item, 500);
	}

	// branches to craft_bait_start | check_if_fishing
	function throw_rod() {
		console.log("throw_rod()");
	  if (baitId && !invenItems.filter((item) => item.id === baitId).length) {
			command.message("No bait found in inventory, crafting...");
			mod.setTimeout(craft_bait_start, rng(ACTION_DELAY_FISH_START)/4);
		} else if (rodId) {
			console.log("< C_USE_ITEM.3:rodId");
			mod.toServer('C_USE_ITEM', 3, {
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
			mod.setTimeout(check_if_fishing, rng(ACTION_DELAY_FISH_START)+180000); // 180 sec cuz after dismantling it might take 2+ minutes for a fish to bite
		}	else {
			command.message("No rod used.");
			stop_fishing();
		}
	}

	// no branch
	function reel_the_fish() {
		 console.log("reel_the_fish()");

		 console.log("< C_START_FISHING_MINIGAME.1");
		 mod.toServer("C_START_FISHING_MINIGAME", 1, {counter:1, unk:15});
	}

	// branches to throw_rod
	function catch_the_fish() {
		console.log("catch_the_fish()");

		statFished++;
		console.log("< C_END_FISHING_MINIGAME.1");
		mod.toServer("C_END_FISHING_MINIGAME", 1, {counter:1, unk:24, success:true});
		mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD)+1000);
	}

	// no branch
	function stop_fishing() {
		console.log("stop_fishing()");

		enabled = false
		vContractId = null;
		bTooManyFish = false;
		bTriedDismantling = false;
		putinfishes = 0;
		unload();
		mod.clearAllTimeouts();
		if (!bWaitingForBite)	{
			let d = new Date();
			let t = d.getTime();
			let timeElapsedMSec = t-statStarted;
			d = new Date(1970, 0, 1); // Epoch
			d.setMilliseconds(timeElapsedMSec);
			let h = addZero(d.getHours());
			let m = addZero(d.getMinutes());
			let s = addZero(d.getSeconds());
			command.message('Fished out: ' + statFished + ' fishes. Time elapsed: ' + (h + ":" + m + ":" + s) + ". Per fish: " + Math.round((timeElapsedMSec / statFished) / 1000) + " sec");
			command.message('Fishes: ');
			for (let i in statFishedTiers)	{
				command.message('Tier ' + i + ': ' + statFishedTiers[i]);
			}
			statFished = 0;
			statFishedTiers = {};
		}	else {
			command.message('You decided not to fish?');
		}
	}

	// branches to cleanup_by_dismantle | reset_fishing
	function dismantle_more() {
		console.log("dismantle_more()");

		awaiting_dismantling =- putinfishes;
		putinfishes = 0;

		if (bTooManyFish) {	mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START)+5500); }// timeout backup function	}
		else {mod.setTimeout(reset_fishing, rng(ACTION_DELAY_FISH_START));}
	}

	// branches to cleanup_by_dismantle | use_bait_item
	function craft_bait_start(chain) {
		console.log("craft_bait_start()");

		if (craftId) {
			let filets = invenItems.find((item) => item.id === 204052);
			let needed = (chain ? 2 : 1) * (15 + ((craftId - 204100) * 5)); // inven gets updated AFTER you send another C_START_PRODUCE
			if (filets && filets.amount >= needed ) {  // need one more to trigger "can't craft more bait"
				console.log("< C_START_PRODUCE.1:craftId");
				mod.toServer('C_START_PRODUCE', 1, {recipe:craftId, unk: 0});
				baitId = BAIT_RECIPES.find(obj => obj.recipeId === craftId).itemId;
			} else if(!bTriedDismantling)	{
				bTriedDismantling = true;
				mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_THROW_ROD));
				command.message("You don't have enough fish parts to craft a bait... dismantling fishes to get some");
			} else if(chain || invenItems.filter((item) => item.id === baitId).length) {
				command.message("Crafted few bait items, then ran out of fish parts, fishing...");
				mod.setTimeout(use_bait_item, rng(ACTION_DELAY_FISH_START));
			} else {
				notificationAFK("You don't have enough filets or fish to craft bait. Stopping.");
				stop_fishing();
			}
		} else {
			notificationAFK("You didn't provide a sample craft recipe for bait. Stopping.");
			stop_fishing();
		}
	}

	// branches to throw_rod
	function use_bait_item() {
		console.log("use_bait_item()");

		if (baitId) {
			bTriedDismantling = false;
			console.log("< C_USE_ITEM.3:baitId");
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
		}	else {
			notificationAFK("No bait.");
			stop_fishing();
		}
	}

	// branches to add_fish_to_dismantler | reset_fishing
	function cleanup_by_dismantle()	{
		console.log("cleanup_by_dismantle()");

		if (enabled) {
			if (bDismantleFish || bDismantleFishGold)	{
				fishList.length = 0;
				if (bDismantleFish) { fishList = invenItems.filter((item) => item.id >= 206400 && item.id <= 206456); }
				if (bDismantleFishGold) { fishList = fishList.concat(invenItems.filter((item) => item.id >= 206500 && item.id <= 206514)); }

				if (fishList.length > 20) {
					console.log("Total fish: " + fishList.length);
					awaiting_dismantling = fishList.length;
					bTooManyFish = true;
					while (fishList.length > 20) {	fishList.pop();	}
				} else { bTooManyFish = false; }

				if (fishList.length) {
					command.message("Dismantling " + fishList.length + " fish.");
					if (!vContractId) {
						vContractId = mod.toServer('C_REQUEST_CONTRACT', 1, {type: dismantle_contract_type});
						console.log("< C_REQUEST_CONTRACT.1:DECOMP=" + vContractId);
					}
					mod.setTimeout(add_fish_to_dismantler, (rng(ACTION_DELAY_FISH_START)+15000));
				}	else if(awaiting_dismantling <= 0) {
					notificationAFK("Cannot dismantle anything.");
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
				notificationAFK("Auto-dismamtle is disabled. Unable to clean-up. Stopping.");
				stop_fishing();
			}
		}
	}

	// branches to add_fish_to_dismantler | commit_dismantler | cleanup_by_dismantle
	function add_fish_to_dismantler()	{
		console.log("add_fish_to_dismantler()");

		if (vContractId) {
			const fish = fishList.pop();
			if (fish)	{
				command.message("Requesting dismantle of: " + fish.id + ", " + fish.dbid);
				console.log("< C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1: " + vContractId + ", Fid:"  + fish.id + ":DBid:" + fish.dbid + "->Contract=" + vContractId);
				mod.toServer('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, {
					contractId: vContractId,
					dbid: fish.dbid,
					id: fish.id,
					count: 1
				});
				putinfishes++;
			}

			if (fishList.length) {
				mod.setTimeout(add_fish_to_dismantler, (rng(ACTION_DELAY_FISH_START)/2));
			}	else {
				 mod.setTimeout(commit_dismantler, (rng(ACTION_DELAY_FISH_START)/2));
			}
		}	else {
			command.message("No contract found, retrying.");
			mod.setTimeout(cleanup_by_dismantle, (rng(ACTION_DELAY_FISH_START)+1500));
		}
	}

	// branches to throw_rod
	function reset_fishing() {
		console.log("reset_fishing()");

		if (vContractId) {
			console.log("< C_CANCEL_CONTRACT.1:vContractId");
			mod.toServer('C_CANCEL_CONTRACT', 1, {
				type: dismantle_contract_type,
				id: vContractId
			});
			vContractId = null;
		}
		if (enabled) {
			mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD)+1000); // lets resume fishing
		}
	}

	//branches to dismantle_more
	function commit_dismantler() {
		console.log("commit_dismantler()");

		console.log("< C_RQ_COMMIT_DECOMPOSITION_CONTRACT.1:vContractId=" + vContractId);
		mod.toServer('C_RQ_COMMIT_DECOMPOSITION_CONTRACT', 1, { contract: vContractId });
		mod.setTimeout(dismantle_more, 2000);
	}

	mod.hook('C_PLAYER_LOCATION', 5, event => { playerLoc = event; });
	mod.hook('S_LOGIN', mod.majorPatchVersion>=86?14:13, event => {
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
		}	else {
			bDismantleFish = lSettings.bDismantleFish || true;
			bDismantleFishGold = lSettings.bDismantleFishGold || false;
			craftId = lSettings.craftId || 0;
			let found = BAIT_RECIPES.find(obj => obj.recipeId === craftId);
			if (found) { baitId = found.itemId;	}
			else { notificationAFK("Your config file is corrupted, the bait recipe id is invalid."); }
		}
	});

	// fishing pattern entry
	function start() {
		console.log("start() fish_sequence");
		if (hooks.length) return; // edge case where mod isn't loaded properly?

		//Check the server response to C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1
		mod.hook('S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, event => { console.log("> S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT.1: " + event); })

		// branches to catch_the_fish AKA send(C_END_FISHING_MINIGAME.1)
		Hook('S_START_FISHING_MINIGAME', 1, event => {
			if (!enabled || bWaitingForBite) return;

			if (myGameId === event.gameId) { // TODO: update to use mod.game lib
				console.log("> S_START_FISHING_MINIGAME.1:bEnabled&&bHasBite&&bIsMe");
				let fishTier = event.level;
				rodId = event.rodId;

				if (DELAY_BASED_ON_FISH_TIER)	{	curTier = fishTier; }
				statFishedTiers[fishTier] = statFishedTiers[fishTier] ? statFishedTiers[fishTier]+1 : 1;
				command.message("Started fishing minigame, Tier " + fishTier);
				mod.setTimeout(catch_the_fish, (rng(ACTION_DELAY_FISH_CATCH)+(curTier*1000)));
				return false; // Hide the minigame.
			}
		});

		// branches to reel_the_fish
		Hook('S_FISHING_BITE', 1, event => {
			if (!enabled) return;

			if (myGameId === event.gameId) {
				console.log("> S_FISHING_BITE.1:bEnabled&&bIsMe");
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
					command.message("Auto-fishing on." );
				}

				return false; // Hide minigame
			}
		});

		// Stop fishing on tp.
		Hook('S_LOAD_TOPO', 3, event => {
			if (enabled) {
				stop_fishing();
				notificationAFK("Teleported. AF stopped.");
			}
		});

		// branches to cleanup_by_dismantle
		if (mod.majorPatchVersion >= 85) {
			var invenItemsBuffer = [];
			var invenFirst = true;
			Hook('S_ITEMLIST', mod.majorPatchVersion >= 87 ? 3 : 2, event => {
				if (!enabled) return;

				if (event.container !== 14) {
					invenItemsBuffer = event.first ? event.items : invenItemsBuffer.concat(event.items);
					if (!event.more)	{
						if (invenFirst) {
							invenFirst = false;
							invenItems = invenItemsBuffer;
						} else { invenItems = invenItems.concat(invenItemsBuffer); }
					}
				}

				if (!event.more) { console.log(invenItemsBuffer.length + " items in container " + event.container + ", pocket " + event.pocket); }
				if (event.lastInBatch && !event.more) {
					invenFirst = true;
					command.message("You have " + invenItems.length + " items in your inventory.");
					if (bTooManyFish && putinfishes === 0) {
						mod.clearAllTimeouts();
						mod.setTimeout(function() { command.message("Dismantling next batch."); }, ACTION_DELAY_FISH_START[0]/3);
						mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START)/3);
					}
				}
			});
		} else {
			Hook('S_INVEN', 19, event => {
				if (!enabled) return;

				invenItems = event.first ? event.items : invenItems.concat(event.items);
				if(bTooManyFish && putinfishes === 0 && !event.more) {
					mod.clearAllTimeouts();
					mod.setTimeout(function() { command.message("Inventory fully updated, starting dismantling of the next batch of fish"); }, ACTION_DELAY_FISH_START[0]/3);
					mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START)/3);
				}
			});
		}

		// branches to add_fish_to_dismantler
		Hook('S_REQUEST_CONTRACT', 1, event => {
			if (!enabled || bWaitingForBite || event.type != dismantle_contract_type || event.senderId !== myGameId) return;

			vContractId = event.id;
			console.log("Dismantling contract id: " + event.id);
			mod.clearAllTimeouts();
			mod.setTimeout(add_fish_to_dismantler, (rng(ACTION_DELAY_FISH_START)/2));
		});

		// branches to throw_rod
		Hook('S_CANCEL_CONTRACT', 1, event => {
			if (!enabled || bWaitingForBite || event.type != dismantle_contract_type || event.id != vContractId || event.senderId !== myGameId) return;

			vContractId = null;
			command.message("Contract for dismantling cancelled (not by this mod), retrying fishing sequence...");
			mod.clearAllTimeouts();
			mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD));
		});

		// bait craft hook
		Hook('C_START_PRODUCE', 1, event => {
			if (!bWaitingForBite) return;

			craftId = event.recipe;
			let found = BAIT_RECIPES.find(obj => obj.recipeId === event.recipe);
			if (found)	{
				baitId = found.itemId;
				command.message("Crafting bait recipe: " + event.recipe + ", bait: " + baitId);
			}	else { command.message("Craft id is not a bait recipe."); }
		});

		// branches to craft_bait_start
		Hook('S_END_PRODUCE', 1, event => {
			if (!enabled || bWaitingForBite) return;
			if (event.success)	{ craft_bait_start(true); }
		});

		// branches to craft_bait_start | use_bait_item | cleanup_by_dismantle | throw_rod | stop_fishing
		Hook('S_SYSTEM_MESSAGE', 1, event => {
			if (!enabled || bWaitingForBite) return;
			const msg = mod.parseSystemMessage(event.message);

			if (msg.id === 'SMT_CANNOT_FISHING_NON_BAIT')	{
				command.message("Out of bait, crafting...");
				mod.clearAllTimeouts();
				mod.setTimeout(craft_bait_start, rng(ACTION_DELAY_FISH_START));
			} else if(msg.id === 'SMT_ITEM_CANT_POSSESS_MORE') {
				if (!vContractId) {
					mod.clearAllTimeouts();
					let itemId = Number(msg.tokens.ItemName.substr(6));
					if (itemId >= 206006 && itemId <= 206009) {
						command.message("Crafted worms to the fullest, lets fish using those now!");
						baitId = itemId;
					}
					else {
						command.message("Crafted to the fullest, lets fish again!");
					}
					mod.setTimeout(use_bait_item, rng(ACTION_DELAY_FISH_START));
				} else {
					notificationAFK("You have reached the 10k dismantled fish parts limit, stopping.");
					mod.clearAllTimeouts();
					if(putinfishes) {
						bTooManyFish = false;
						enabled = false;
						commit_dismantler();
						setTimeout(stop_fishing, (rng(ACTION_DELAY_FISH_START)+4000));
					} else { stop_fishing(); }
				}
			}	else if (msg.id === 'SMT_CANNOT_FISHING_FULL_INVEN') {
				console.log("Inventory full, dismantling...");
				mod.clearAllTimeouts();
				mod.setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START)+1500);
			}	else if (msg.id === 'SMT_CANNOT_FISHING_NON_AREA')	{
				console.log("Fishing area changed, retrying...");
				mod.clearAllTimeouts();
				leftArea++;
				if (leftArea < 7) {	mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD));	}
				else {
					stop_fishing();
					notificationAFK("Casn't seem to fish in this area, stopping.");
				}
			}	else if (msg.id === 'SMT_FISHING_RESULT_CANCLE')	{
				console.log("Fishing cancelled... Retrying...");
				mod.clearAllTimeouts();
				mod.setTimeout(throw_rod, rng(ACTION_DELAY_FISH_START));
			}	else if (msg.id === 'SMT_YOU_ARE_BUSY' && !vContractId) {
				console.log("Evil people trying to disturb your fishing, retrying...");
				mod.clearAllTimeouts();
				mod.setTimeout(throw_rod, rng(ACTION_DELAY_THROW_ROD)+3000);
			} else if (msg.id === 'SMT_CANNOT_USE_ITEM_WHILE_CONTRACT') {
				console.log("In contract... Retrying...");
				mod.clearAllTimeouts();
				mod.setTimeout(throw_rod, (rng(ACTION_DELAY_THROW_ROD)+3000));
			}
  	});
	}

	// Helpers
	function saveSettings(obj) {
		if (Object.keys(obj).length) {
			try	{	fs.writeFileSync(path.join(__dirname, settingsFileName), JSON.stringify(obj, null, "\t"));	}
			catch (err) {
				command.message("Error saving settings " + err);
				return false;
			}
		}
	}

	function loadSettings() {
		try	{	return JSON.parse(fs.readFileSync(path.join(__dirname, settingsFileName), "utf8"));	}
		catch (err)	{	console.log("Error loading settings " + err);	}
	}

	function addZero(i) {
		if (i < 10) {
			i = "0" + i;
		}
		return i;
	}

	function rng([min, max])  {
		return min + Math.floor(Math.random() * (max - min + 1));
	}

		// TODO: Change to DEBUG log/message with en/dis cmd and sprinkle EVERYWHERE. dnl/dnm by default, tags/filters?
		// this way i can filter console.log instead of using directly. I don't have notifier anyways, but will build a quietable version.
	function notificationAFK(msg, timeout) {
		command.message(msg);
		console.log(msg);
		if (notifier !== false)	{
			notifier.notifyafk({
				title: 'Fishing',
				message: msg,
				wait: false,
				sound: 'Notification.IM',
			}, timeout);
		}
	}

	function unload() {
		if (hooks.length) {
			for (let h of hooks) mod.unhook(h);
			hooks = [];
		}
	}

	function Hook()	{	hooks.push(mod.hook(...arguments));	}
}
