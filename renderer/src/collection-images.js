"use strict";

import img100k from "./img/nft/100k.webp";
import img500k from "./img/nft/500k.webp";
import imgCndy from "./img/nft/cndy.webp";
import imgDay100 from "./img/nft/day100.webp";
import imgDrip from "./img/nft/drip.webp";
import imgGoats from "./img/nft/goats.webp";
import imgMarbleverse from "./img/nft/marbleverse.webp";
import imgMobies from "./img/nft/mobies.webp";
import imgMos40 from "./img/nft/mos40.webp";
import imgTheMobies from "./img/nft/themobies.webp";
import imgTkm from "./img/nft/tkm.webp";
import imgTonya from "./img/nft/tonya.webp";
import imgUndead from "./img/nft/undead.webp";

export function normalizeCollectionKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

const COLLECTION_IMAGE_BY_KEY = new Map([
  ["iook", img100k],
  ["100k", img100k],
  ["100 k", img100k],
  ["100000", img100k],
  ["100 000", img100k],
  ["100k club", img100k],

  ["sook", img500k],
  ["500k", img500k],
  ["500 k", img500k],
  ["500000", img500k],
  ["500 000", img500k],
  ["500k club", img500k],

  ["candy", imgCndy],
  ["cndy", imgCndy],

  ["day100", imgDay100],
  ["day 100", imgDay100],

  ["drip", imgDrip],
  ["drippies", imgDrip],

  ["greatgoats", imgGoats],
  ["goats", imgGoats],
  ["goat", imgGoats],
  ["great goats", imgGoats],

  ["mvone", imgMarbleverse],
  ["marbleverse", imgMarbleverse],
  ["marble verse", imgMarbleverse],
  ["marbles", imgMarbleverse],
  ["marble", imgMarbleverse],

  ["morbie", imgMobies],
  ["mobies", imgMobies],
  ["morbies", imgMobies],

  ["morb", imgTheMobies],
  ["the mobies", imgTheMobies],
  ["themobies", imgTheMobies],
  ["themorbies", imgTheMobies],
  ["the morbies", imgTheMobies],

  ["mos40", imgMos40],
  ["mos 40", imgMos40],
  ["mos season 40", imgMos40],
  ["season 40", imgMos40],
  ["szn 40", imgMos40],
  ["szn40", imgMos40],

  ["known", imgTkm],
  ["tkm", imgTkm],

  ["tonya", imgTonya],

  ["ug", imgUndead],
  ["undead", imgUndead],
  ["undead genesis", imgUndead],
  ["un dead genesis", imgUndead],
]);

export function localCollectionImage(name) {
  const key = normalizeCollectionKey(name);
  return COLLECTION_IMAGE_BY_KEY.get(key) || null;
}
