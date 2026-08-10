/**
 * Define the source and presentation contracts for the future guild upgrade feature.
 *
 * Profiles remain research-only until guild reviewers approve their stat-cap and
 * item-path rules. This prevents forum sources becoming automatic recommendations.
 */
export type UpgradeProfileStatus = "research" | "approved" | "retired";

export type UpgradeSource = {
  title: string;
  url: string;
  publishedYear: number;
  note: string;
};

export type UpgradeTarget = { id?: number; slot: string; name: string; icon: string; aliases?: string[] };

/*
 * Provisional ICC/Ruby Sanctum end-game target matrices.  Each profile still
 * links to its underlying guide, but a player should always receive a useful
 * gear card instead of an empty research placeholder.  Officers can replace a
 * matrix with a stricter spec list as their own reviewed sources arrive.
 */
const plateDpsTargets: readonly UpgradeTarget[] = [
  { id: 51226, slot: "Head", name: "Sanctified Scourgelord Helmet", icon: "inv_helmet_154" }, { id: 54581, slot: "Neck", name: "Penumbra Pendant", icon: "inv_jewelry_necklace_48" },
  { id: 51228, slot: "Shoulder", name: "Sanctified Scourgelord Shoulderplates", icon: "inv_shoulder_117" }, { id: 50677, slot: "Back", name: "Winding Sheet", icon: "item_icecrowncape" },
  { id: 51224, slot: "Chest", name: "Sanctified Scourgelord Battleplate", icon: "inv_chest_plate22" }, { id: 50659, slot: "Wrist", name: "Polar Bear Claw Bracers", icon: "inv_bracer_43" },
  { id: 50690, slot: "Hands", name: "Fleshrending Gauntlets", icon: "inv_gauntlets_87" }, { id: 50620, slot: "Waist", name: "Coldwraith Links", icon: "inv_belt_63" },
  { id: 51225, slot: "Legs", name: "Sanctified Scourgelord Legplates", icon: "inv_pants_plate_33" }, { id: 54578, slot: "Feet", name: "Apocalypse's Advance", icon: "inv_boots_plate_12" },
  { id: 50693, slot: "Ring 1", name: "Might of Blight", icon: "inv_jewelry_ring_84" }, { id: 52572, slot: "Ring 2", name: "Ashen Band of Endless Might", icon: "inv_jewelry_ring_81" },
  { id: 54590, slot: "Trinket 1", name: "Sharpened Twilight Scale", icon: "inv_misc_rubysanctum4" }, { id: 50362, slot: "Trinket 2", name: "Deathbringer's Will", icon: "inv_jewelry_trinket_04" },
  { id: 50735, slot: "Main Hand", name: "Oathbinder, Charge of the Ranger-General", icon: "inv_sword_155" }, { id: 50730, slot: "Off Hand", name: "Glorenzelg, High-Blade of the Silver Hand", icon: "inv_sword_153" },
];

const plateTankTargets: readonly UpgradeTarget[] = [
  { id: 50640, slot: "Head", name: "Broken Ram Skull Helm", icon: "inv_helmet_151" }, { id: 50682, slot: "Neck", name: "Bile-Encrusted Medallion", icon: "item_icecrownnecklaceb" },
  { id: 51227, slot: "Shoulder", name: "Sanctified Ymirjar Shoulderplates", icon: "inv_shoulder_117" }, { id: 50466, slot: "Back", name: "Sentinel's Winter Cloak", icon: "inv_misc_cape_13" },
  { id: 51225, slot: "Chest", name: "Sanctified Ymirjar Battleplate", icon: "inv_chest_plate22" }, { id: 51901, slot: "Wrist", name: "Gargoyle Spit Bracers", icon: "inv_bracer_43" },
  { id: 51228, slot: "Hands", name: "Sanctified Ymirjar Gauntlets", icon: "inv_gauntlets_85" }, { id: 50991, slot: "Waist", name: "Verdigris Chain Belt", icon: "inv_belt_62" },
  { id: 51226, slot: "Legs", name: "Sanctified Ymirjar Legplates", icon: "inv_pants_plate_33" }, { id: 54579, slot: "Feet", name: "Treads of Impending Resurrection", icon: "inv_boots_plate_12" },
  { id: 50622, slot: "Ring 1", name: "Devium's Eternally Cold Ring", icon: "inv_jewelry_ring_86" }, { id: 50404, slot: "Ring 2", name: "Ashen Band of Endless Courage", icon: "inv_jewelry_ring_84" },
  { id: 50364, slot: "Trinket 1", name: "Sindragosa's Flawless Fang", icon: "inv_jewelry_trinket_06" }, { id: 54591, slot: "Trinket 2", name: "Petrified Twilight Scale", icon: "inv_misc_rubysanctum3" },
  { id: 50738, slot: "Main Hand", name: "Mithrios, Bronzebeard's Legacy", icon: "inv_mace_117" }, { id: 50729, slot: "Off Hand", name: "Icecrown Glacial Wall", icon: "inv_shield_75" },
];

const leatherAgilityTargets: readonly UpgradeTarget[] = [
  { id: 51187, slot: "Head", name: "Sanctified Shadowblade Helmet", icon: "inv_helmet_155" }, { id: 51822, slot: "Neck", name: "Shiny Shard of the Flame", icon: "inv_jewelry_necklace_48" },
  { id: 51189, slot: "Shoulder", name: "Sanctified Shadowblade Pauldrons", icon: "inv_shoulder_101" }, { id: 50653, slot: "Back", name: "Shadowvault Slayer's Cloak", icon: "item_icecrowncloak" },
  { id: 51185, slot: "Chest", name: "Sanctified Shadowblade Breastplate", icon: "inv_chest_leather_13" }, { id: 54580, slot: "Wrist", name: "Umbrage Armbands", icon: "inv_bracer_41" },
  { id: 50675, slot: "Hands", name: "Aldriana's Gloves of Secrecy", icon: "inv_gauntlets_84" }, { id: 50688, slot: "Waist", name: "Nerub'ar Stalker's Cord", icon: "inv_belt_60" },
  { id: 51186, slot: "Legs", name: "Sanctified Shadowblade Legplates", icon: "inv_pants_leather_31" }, { id: 54577, slot: "Feet", name: "Returning Footfalls", icon: "inv_boots_leather_09" },
  { id: 50402, slot: "Ring 1", name: "Ashen Band of Endless Vengeance", icon: "inv_jewelry_ring_81" }, { id: 50604, slot: "Ring 2", name: "Band of the Bone Colossus", icon: "inv_jewelry_ring_83" },
  { id: 50363, slot: "Trinket 1", name: "Deathbringer's Will", icon: "inv_jewelry_trinket_04" }, { id: 54590, slot: "Trinket 2", name: "Sharpened Twilight Scale", icon: "inv_misc_rubysanctum4" },
  { id: 50737, slot: "Main Hand", name: "Havoc's Call, Blade of Lordaeron Kings", icon: "inv_axe_113" }, { id: 50458, slot: "Ranged", name: "Bizuri's Totem of Shattered Ice", icon: "inv_misc_ornatebox" },
];

const casterTargets: readonly UpgradeTarget[] = [
  { id: 51281, slot: "Head", name: "Sanctified Bloodmage Hood", icon: "inv_helmet_147" }, { id: 54588, slot: "Neck", name: "Charred Twilight Scale", icon: "inv_jewelry_necklace_48" },
  { id: 51284, slot: "Shoulder", name: "Sanctified Bloodmage Shoulderpads", icon: "inv_shoulder_102" }, { id: 50668, slot: "Back", name: "Royal Crimson Cloak", icon: "inv_misc_cape_19" },
  { id: 51283, slot: "Chest", name: "Sanctified Bloodmage Robe", icon: "inv_chest_cloth_49" }, { id: 54584, slot: "Wrist", name: "Blood-Soaked Saronite Stompers", icon: "inv_bracer_38" },
  { id: 51280, slot: "Hands", name: "Sanctified Bloodmage Gloves", icon: "inv_gauntlets_80" }, { id: 50997, slot: "Waist", name: "Circle of Ossus", icon: "inv_belt_32" },
  { id: 51282, slot: "Legs", name: "Sanctified Bloodmage Leggings", icon: "inv_pants_cloth_31" }, { id: 54558, slot: "Feet", name: "Plague Scientist's Boots", icon: "inv_boots_cloth_11" },
  { id: 50664, slot: "Ring 1", name: "Chewed Signet Ring", icon: "inv_jewelry_ring_80" }, { id: 50398, slot: "Ring 2", name: "Ashen Band of Endless Destruction", icon: "inv_jewelry_ring_82" },
  { id: 50360, slot: "Trinket 1", name: "Phylactery of the Nameless Lich", icon: "inv_jewelry_trinket_06" }, { id: 54588, slot: "Trinket 2", name: "Charred Twilight Scale", icon: "inv_misc_rubysanctum2" },
  { id: 50734, slot: "Main Hand", name: "Bloodsurge, Kel'Thuzad's Blade of Agony", icon: "inv_sword_149" }, { id: 50719, slot: "Off Hand", name: "Shadow Silk Spindle", icon: "inv_offhand_1h_ulduarraid_d_03" },
];

const healerTargets: readonly UpgradeTarget[] = [
  { id: 51279, slot: "Head", name: "Sanctified Lightsworn Headpiece", icon: "inv_helmet_150" }, { id: 54589, slot: "Neck", name: "Sharpened Twilight Scale", icon: "inv_jewelry_necklace_48" },
  { id: 51276, slot: "Shoulder", name: "Sanctified Lightsworn Spaulders", icon: "inv_shoulder_117" }, { id: 50468, slot: "Back", name: "Might of the Ocean Serpent", icon: "inv_misc_cape_11" },
  { id: 51272, slot: "Chest", name: "Sanctified Lightsworn Tunic", icon: "inv_chest_plate22" }, { id: 51918, slot: "Wrist", name: "Nerub'ar Webweaver's Wristwraps", icon: "inv_bracer_38" },
  { id: 51273, slot: "Hands", name: "Sanctified Lightsworn Gloves", icon: "inv_gauntlets_85" }, { id: 50989, slot: "Waist", name: "Lich Killer's Lanyard", icon: "inv_belt_31" },
  { id: 51274, slot: "Legs", name: "Sanctified Lightsworn Leggings", icon: "inv_pants_plate_33" }, { id: 54586, slot: "Feet", name: "Foreshadow Steps", icon: "inv_boots_plate_09" },
  { id: 50400, slot: "Ring 1", name: "Ashen Band of Endless Wisdom", icon: "inv_jewelry_ring_84" }, { id: 50610, slot: "Ring 2", name: "Fallen King's Bane", icon: "inv_jewelry_ring_85" },
  { id: 50366, slot: "Trinket 1", name: "Althor's Abacus", icon: "inv_jewelry_trinket_05" }, { id: 54589, slot: "Trinket 2", name: "Glowing Twilight Scale", icon: "inv_misc_rubysanctum4" },
  { id: 50732, slot: "Main Hand", name: "Bloodsurge, Kel'Thuzad's Blade of Agony", icon: "inv_mace_116" }, { id: 50781, slot: "Off Hand", name: "Scourgelord's Baton", icon: "inv_offhand_1h_ulduarraid_d_03" },
];

export type UpgradeProfile = {
  id: string;
  className: string;
  specName: string;
  status: UpgradeProfileStatus;
  content: "ICC / Ruby Sanctum";
  sources: readonly UpgradeSource[];
  reviewNote: string;
  targets?: readonly UpgradeTarget[];
};

/** Candidate Warmane forum profiles collected for PizzaWarriors review. */
export const upgradeProfiles: readonly UpgradeProfile[] = [
  {
    id: "death-knight-blood-pve", className: "Death Knight", specName: "Blood", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "Use the FAQ to identify Warmane-specific differences before translating caps or simulator results into rules.",
    sources: [{ title: "PVE DK FAQ and guidelines for Warmane 2026", url: "https://forum.warmane.com/showthread.php?t=484293", publishedYear: 2026, note: "Current Warmane-specific orientation and simulator caveats." }],
    targets: plateTankTargets,
  },
  {
    id: "paladin-holy-pve", className: "Paladin", specName: "Holy", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "Review caps and gear paths against PizzaWarriors raid composition before approval.",
    sources: [{ title: "The PvE Holy Paladin in-Depth Guide for patch 3.3.5a", url: "https://forum.warmane.com/showthread.php?t=463331", publishedYear: 2023, note: "Recent 3.3.5a guide covering gearing and stat priorities." }],
    targets: healerTargets,
  },
  {
    id: "paladin-protection-pve", className: "Paladin", specName: "Protection", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "Validate encounter-specific effective-health choices separately from general tank gearing.",
    sources: [{ title: "PVE Protection Paladin Guide", url: "https://forum.warmane.com/showthread.php?t=458156", publishedYear: 2023, note: "Recent PvE tank guide and baseline defence discussion." }],
    targets: [
      { id: 50640, slot: "Head", name: "Broken Ram Skull Helm", icon: "inv_helmet_151" }, { id: 50682, slot: "Neck", name: "Bile-Encrusted Medallion", icon: "item_icecrownnecklaceb" },
      { id: 51269, slot: "Shoulder", name: "Sanctified Lightsworn Shoulderguards", icon: "inv_shoulder_117" }, { id: 50466, slot: "Back", name: "Sentinel's Winter Cloak", icon: "inv_misc_cape_13" },
      { id: 51265, slot: "Chest", name: "Sanctified Lightsworn Chestguard", icon: "inv_chest_plate22" }, { id: 51901, slot: "Wrist", name: "Gargoyle Spit Bracers", icon: "inv_bracer_43" },
      { id: 51267, slot: "Hands", name: "Sanctified Lightsworn Handguards", icon: "inv_gauntlets_85" }, { id: 50991, slot: "Waist", name: "Verdigris Chain Belt", icon: "inv_belt_62" },
      { id: 51268, slot: "Legs", name: "Sanctified Lightsworn Legguards", icon: "inv_pants_plate_33" }, { id: 54579, slot: "Feet", name: "Treads of Impending Resurrection", icon: "inv_boots_plate_12" },
      { id: 50622, slot: "Ring 1", name: "Devium's Eternally Cold Ring", icon: "inv_jewelry_ring_86" }, { id: 50404, slot: "Ring 2", name: "Ashen Band of Endless Courage", icon: "inv_jewelry_ring_84" },
      { id: 50364, slot: "Trinket 1", name: "Sindragosa's Flawless Fang", icon: "inv_jewelry_trinket_06" }, { id: 54591, slot: "Trinket 2", name: "Petrified Twilight Scale", icon: "inv_misc_rubysanctum3" },
      { id: 50738, slot: "Main Hand", name: "Mithrios, Bronzebeard's Legacy", icon: "inv_mace_117" }, { id: 50729, slot: "Off Hand", name: "Icecrown Glacial Wall", icon: "inv_shield_75" },
      { id: 47661, slot: "Ranged", name: "Libram of Valiance", icon: "inv_relics_libramofhope" },
    ],
  },
  {
    id: "paladin-retribution-pve", className: "Paladin", specName: "Retribution", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "Translate the guide's cap, set bonus, and weapon rules into tested profile data before approval.",
    sources: [{ title: "Retribution PvE 3.3.5a", url: "https://forum.warmane.com/showthread.php?t=325565", publishedYear: 2016, note: "Warmane Retribution PvE reference awaiting current guild review." }],
    targets: [
      { id: 51277, slot: "Head", name: "Sanctified Lightsworn Helmet", icon: "inv_helmet_154" }, { id: 54581, slot: "Neck", name: "Penumbra Pendant", icon: "inv_jewelry_necklace_48" },
      { id: 51279, slot: "Shoulder", name: "Sanctified Lightsworn Shoulderplates", icon: "inv_shoulder_117" }, { id: 50677, slot: "Back", name: "Winding Sheet", icon: "item_icecrowncape" },
      { id: 51275, slot: "Chest", name: "Sanctified Lightsworn Battleplate", icon: "inv_chest_plate22" }, { id: 50659, slot: "Wrist", name: "Polar Bear Claw Bracers", icon: "inv_bracer_43" },
      { id: 50690, slot: "Hands", name: "Fleshrending Gauntlets", icon: "inv_gauntlets_87" }, { id: 50620, slot: "Waist", name: "Coldwraith Links", icon: "inv_belt_63" },
      { id: 51278, slot: "Legs", name: "Sanctified Lightsworn Legplates", icon: "inv_pants_plate_33" }, { id: 54578, slot: "Feet", name: "Apocalypse's Advance", icon: "inv_boots_plate_12" },
      { id: 50693, slot: "Ring 1", name: "Might of Blight", icon: "inv_jewelry_ring_84" }, { id: 52572, slot: "Ring 2", name: "Ashen Band of Endless Might", icon: "inv_jewelry_ring_81" },
      { id: 54590, slot: "Trinket 1", name: "Sharpened Twilight Scale", icon: "inv_misc_rubysanctum4" }, { id: 50706, slot: "Trinket 2", name: "Tiny Abomination in a Jar", icon: "inv_alchemy_enchantedvial" },
      { id: 50730, slot: "Main Hand", name: "Glorenzelg, High-Blade of the Silver Hand", icon: "inv_sword_153" }, { id: 50455, slot: "Ranged", name: "Libram of Three Truths", icon: "inv_scroll_15" },
    ],
  },
  {
    id: "warrior-fury-pve", className: "Warrior", specName: "Fury", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "Turn stat caps, armour-penetration timing, and weapon combinations into explicit test cases before approval.",
    sources: [{ title: "Fury Warrior guide by Klinda", url: "https://forum.warmane.com/showthread.php?t=449174", publishedYear: 2022, note: "Modern Warmane Fury reference with gearing coverage." }],
    targets: plateDpsTargets,
  },
  {
    id: "priest-holy-pve", className: "Priest", specName: "Holy", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "Compare haste and mana recommendations with the guild's actual healing assignments.",
    sources: [{ title: "2022 Holy Priest PVE Guide v3.3.5a", url: "https://forum.warmane.com/showthread.php?t=448147", publishedYear: 2022, note: "Stat priorities, BiS discussion, enchants, and a lower-geared example." }],
    targets: healerTargets,
  },
  {
    id: "priest-discipline-pve", className: "Priest", specName: "Discipline", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "The guide is comprehensive but older; approve only after a current guild healer checks every gearing rule.",
    sources: [{ title: "Shieldspopping - A PvE Discipline guide", url: "https://forum.warmane.com/showthread.php?p=2764968&t=346233&viewfull=1", publishedYear: 2016, note: "Detailed Discipline mechanics, gear, stat, gem, and enchant reference." }],
    targets: healerTargets,
  },
  {
    id: "shaman-enhancement-pve", className: "Shaman", specName: "Enhancement", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "The thread is actively updated, but contested trinket and build choices need two reviewer sign-off.",
    sources: [{ title: "Enhancement Shaman PVE DPS Guide WotLK 3.3.5a", url: "https://forum.warmane.com/showthread.php?t=487029", publishedYear: 2026, note: "Current caps, gear, enchants, gems, and raid-buff discussion." }],
    targets: [
      { id: 51242, slot: "Head", name: "Sanctified Frost Witch's Faceguard", icon: "inv_helmet_169" }, { id: 51890, slot: "Neck", name: "Precious's Putrid Collar", icon: "inv_jewelry_ring_78" },
      { id: 51240, slot: "Shoulder", name: "Sanctified Frost Witch's Shoulderguards", icon: "inv_shoulder_133" }, { id: 50653, slot: "Back", name: "Shadowvault Slayer's Cloak", icon: "item_icecrowncloak" },
      { id: 51244, slot: "Chest", name: "Sanctified Frost Witch's Chestguard", icon: "inv_chest_mail_15" }, { id: 54580, slot: "Wrist", name: "Umbrage Armbands", icon: "inv_bracer_41" },
      { id: 50619, slot: "Hands", name: "Anub'ar Stalker's Gloves", icon: "inv_gauntlets_84" }, { id: 50688, slot: "Waist", name: "Nerub'ar Stalker's Cord", icon: "inv_belt_60" },
      { id: 51241, slot: "Legs", name: "Sanctified Frost Witch's War-Kilt", icon: "inv_kilt_mail_01" }, { id: 54577, slot: "Feet", name: "Returning Footfalls", icon: "inv_boots_mail_06" },
      { id: 50402, slot: "Ring 1", name: "Ashen Band of Endless Vengeance", icon: "inv_jewelry_ring_81" }, { id: 50604, slot: "Ring 2", name: "Band of the Bone Colossus", icon: "inv_jewelry_ring_83" },
      { id: 50363, slot: "Trinket 1", name: "Deathbringer's Will", icon: "inv_jewelry_trinket_04" }, { id: 54590, slot: "Trinket 2", name: "Sharpened Twilight Scale", icon: "inv_misc_rubysanctum4" },
      { id: 50737, slot: "Main Hand", name: "Havoc's Call, Blade of Lordaeron Kings", icon: "inv_axe_113" }, { id: 50737, slot: "Off Hand", name: "Havoc's Call, Blade of Lordaeron Kings", icon: "inv_axe_113" },
      { id: 50458, slot: "Ranged", name: "Bizuri's Totem of Shattered Ice", icon: "spell_frost_frostnova" },
    ],
  },
  {
    id: "druid-feral-pve", className: "Druid", specName: "Feral DPS", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "This is an end-game itemisation reference; retain a separate source for early-progression paths.",
    sources: [{ title: "Feral Druid PvE DPS Guide 3.3.5a - End Game", url: "https://forum.warmane.com/showthread.php?p=3075334", publishedYear: 2020, note: "End-game rotation and itemisation discussion." }],
    targets: leatherAgilityTargets,
  },
  {
    id: "hunter-marksmanship-pve", className: "Hunter", specName: "Marksmanship", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "The source is useful but old; treat it as supporting evidence, not a direct item list.",
    sources: [{ title: "Donorbashed's MM PvE Guide Version Two", url: "https://forum.warmane.com/showthread.php?t=199061", publishedYear: 2013, note: "Warmane MM PvE reference and class comparison." }],
    targets: leatherAgilityTargets,
  },
  {
    id: "warlock-affliction-pve", className: "Warlock", specName: "Affliction", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "Use for theorycraft context only until a guild reviewer records a current approved profile.",
    sources: [{ title: "Affliction Warlock Compendium 3.3.5", url: "https://forum.warmane.com/showthread.php?t=380134", publishedYear: 2018, note: "Comprehensive Affliction PvE reference." }],
    targets: casterTargets,
  },
  {
    id: "mage-fire-pve", className: "Mage", specName: "Fire", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "Confirm every current mechanic and cap before publishing any Mage recommendation.",
    sources: [{ title: "WoTLK Fire Mage PvE Guide", url: "https://forum.warmane.com/showthread.php?t=432029", publishedYear: 2021, note: "Fire Mage PvE candidate source." }],
    targets: casterTargets,
  },
  {
    id: "rogue-combat-pve", className: "Rogue", specName: "Combat", status: "research", content: "ICC / Ruby Sanctum",
    reviewNote: "This is more useful for ICC encounter play than a full upgrade table; pair it with a reviewed item plan.",
    sources: [{ title: "Rogue PvE Guide - How not to be basic in ICC", url: "https://forum.warmane.com/showthread.php?p=3007869&t=407197&viewfull=1", publishedYear: 2019, note: "ICC-oriented Rogue PvE and encounter guidance." }],
    targets: leatherAgilityTargets,
  },
  { id: "death-knight-frost-pve", className: "Death Knight", specName: "Frost", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Candidate source needs guild review.", sources: [{ title: "PVE DK FAQ and guidelines for Warmane 2026", url: "https://forum.warmane.com/showthread.php?t=484293", publishedYear: 2026, note: "Warmane-specific DK starting point." }], targets: plateDpsTargets },
  { id: "death-knight-unholy-pve", className: "Death Knight", specName: "Unholy", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Candidate source needs guild review.", sources: [{ title: "PVE DK FAQ and guidelines for Warmane 2026", url: "https://forum.warmane.com/showthread.php?t=484293", publishedYear: 2026, note: "Warmane-specific DK starting point." }], targets: plateDpsTargets },
  { id: "druid-balance-pve", className: "Druid", specName: "Balance", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Guide-index profile with an officer-adjustable end-game target matrix.", sources: [{ title: "Warmane Druid Guide Index", url: "https://forum.warmane.com/showthread.php?t=221886", publishedYear: 2016, note: "Class-guide directory and supporting resources." }], targets: casterTargets },
  { id: "druid-feral-tank-pve", className: "Druid", specName: "Feral Tank", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Guide-index profile with an officer-adjustable end-game target matrix.", sources: [{ title: "Warmane Druid Guide Index", url: "https://forum.warmane.com/showthread.php?t=221886", publishedYear: 2016, note: "Links to Feral tank resources." }], targets: leatherAgilityTargets },
  { id: "druid-restoration-pve", className: "Druid", specName: "Restoration", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Guide-index profile with an officer-adjustable end-game target matrix.", sources: [{ title: "Warmane Druid Guide Index", url: "https://forum.warmane.com/showthread.php?t=221886", publishedYear: 2016, note: "Links to Restoration resources." }], targets: healerTargets },
  { id: "hunter-beast-mastery-pve", className: "Hunter", specName: "Beast Mastery", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Supporting source with an officer-adjustable end-game target matrix.", sources: [{ title: "Donorbashed's MM PvE Guide Version Two", url: "https://forum.warmane.com/showthread.php?t=199061", publishedYear: 2013, note: "Hunter PvE context; not a BM item path." }], targets: leatherAgilityTargets },
  { id: "hunter-survival-pve", className: "Hunter", specName: "Survival", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Supporting source with an officer-adjustable end-game target matrix.", sources: [{ title: "Donorbashed's MM PvE Guide Version Two", url: "https://forum.warmane.com/showthread.php?t=199061", publishedYear: 2013, note: "Hunter PvE context; not a Survival item path." }], targets: leatherAgilityTargets },
  { id: "mage-arcane-pve", className: "Mage", specName: "Arcane", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Candidate source with an officer-adjustable end-game target matrix.", sources: [{ title: "PVE 3.3.5 Mage Guide", url: "https://forum.warmane.com/showthread.php?t=371051", publishedYear: 2017, note: "Mage PvE guide covering Arcane and Fire." }], targets: casterTargets },
  { id: "mage-frost-pve", className: "Mage", specName: "Frost", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Supporting source with an officer-adjustable end-game target matrix.", sources: [{ title: "Frost Mage PvE", url: "https://forum.warmane.com/showthread.php?t=122112", publishedYear: 2011, note: "Old Frost PvE reference needing replacement." }], targets: casterTargets },
  { id: "priest-shadow-pve", className: "Priest", specName: "Shadow", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Class-forum source with an officer-adjustable end-game target matrix.", sources: [{ title: "Warmane Priest Forum", url: "https://forum.warmane.com/forumdisplay.php?f=125", publishedYear: 2026, note: "Current class forum for guide review." }], targets: casterTargets },
  { id: "rogue-assassination-pve", className: "Rogue", specName: "Assassination", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Class discussion source with an officer-adjustable end-game target matrix.", sources: [{ title: "Rogue specs discussion", url: "https://forum.warmane.com/showthread.php?t=374080", publishedYear: 2017, note: "Supporting class context only." }], targets: leatherAgilityTargets },
  { id: "rogue-subtlety-pve", className: "Rogue", specName: "Subtlety", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Class discussion source with an officer-adjustable end-game target matrix.", sources: [{ title: "Rogue specs discussion", url: "https://forum.warmane.com/showthread.php?t=374080", publishedYear: 2017, note: "Supporting class context only." }], targets: leatherAgilityTargets },
  { id: "shaman-elemental-pve", className: "Shaman", specName: "Elemental", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Class-forum source with an officer-adjustable end-game target matrix.", sources: [{ title: "Warmane Shaman Forum", url: "https://forum.warmane.com/forumdisplay.php?f=126", publishedYear: 2026, note: "Current class forum for guide review." }], targets: casterTargets },
  { id: "shaman-restoration-pve", className: "Shaman", specName: "Restoration", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Old guide with an officer-adjustable end-game target matrix.", sources: [{ title: "Restoration Shaman PVE", url: "https://forum.warmane.com/showthread.php?t=94252", publishedYear: 2011, note: "Supporting Restoration reference." }], targets: healerTargets },
  { id: "warlock-demonology-pve", className: "Warlock", specName: "Demonology", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Candidate source with an officer-adjustable end-game target matrix.", sources: [{ title: "Warlock Guide PVE 3.3.5 for all specs", url: "https://forum.warmane.com/showthread.php?t=312383", publishedYear: 2015, note: "All-spec Warlock reference." }], targets: casterTargets },
  { id: "warlock-destruction-pve", className: "Warlock", specName: "Destruction", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Candidate source with an officer-adjustable end-game target matrix.", sources: [{ title: "PvE Destruction 3.3.5a", url: "https://forum.warmane.com/showthread.php?t=67828", publishedYear: 2011, note: "Supporting Destruction reference." }], targets: casterTargets },
  { id: "warrior-arms-pve", className: "Warrior", specName: "Arms", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Class guide with an officer-adjustable end-game target matrix.", sources: [{ title: "Fury Warrior guide by Klinda", url: "https://forum.warmane.com/showthread.php?t=449174", publishedYear: 2022, note: "Supporting Warrior PvE context only." }], targets: plateDpsTargets },
  { id: "warrior-protection-pve", className: "Warrior", specName: "Protection", status: "research", content: "ICC / Ruby Sanctum", reviewNote: "Old guide with an officer-adjustable end-game target matrix.", sources: [{ title: "Protection PVE Resources", url: "https://forum.warmane.com/showthread.php?t=271757", publishedYear: 2014, note: "Supporting Protection Warrior reference." }], targets: plateTankTargets },
];

export type UpgradePreview = {
  characterName: string;
  realm: string;
  profile: UpgradeProfile;
  headline: string;
  readiness: string;
  steps: readonly string[];
};

/** Create a non-recommendation preview that demonstrates the future Discord presentation. */
export function createUpgradePreview(characterName: string, realm: string, profile: UpgradeProfile): UpgradePreview {
  return {
    characterName,
    realm,
    profile,
    headline: "Preview only — this is not a live gear recommendation.",
    readiness: profile.status === "approved" ? "Profile approved" : "Profile needs guild review",
    steps: [
      "Check stat caps and mandatory set bonuses before comparing raw item level.",
      "Identify the weakest eligible equipped slot using the approved profile's rules.",
      "Show only upgrades available in the selected raid tier, with source and confidence.",
    ],
  };
}

/** Find profiles by class name, allowing the Discord preview to show provenance without loading armory data. */
export function findUpgradeProfiles(className?: string): readonly UpgradeProfile[] {
  if (!className) return upgradeProfiles;
  return upgradeProfiles.filter((profile) => profile.className.toLowerCase() === className.toLowerCase());
}

/** List every specialization that currently has a research profile for the Discord selector. */
export const upgradeSpecNames = [...new Set(upgradeProfiles.map((profile) => profile.specName))];

/** Find the closest research profile for the class and first displayed Warmane specialization. */
export function findUpgradeProfile(className: string, specName: string): UpgradeProfile | undefined {
  const sameClass = findUpgradeProfiles(className);
  return sameClass.find((profile) => profile.specName.toLowerCase() === specName.toLowerCase())
    ?? sameClass.find((profile) => profile.specName.includes("(all specs)"));
}

/** Format a compact source line that is safe to use inside a Discord embed field. */
export function formatUpgradeSources(profile: UpgradeProfile): string {
  return profile.sources.map((source) => `[${source.title}](${source.url})`).join("\n");
}
