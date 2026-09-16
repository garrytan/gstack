/**
 * The site-visit checklist.
 *
 * Every item is something a buyer can only learn by standing there, and every
 * one has cost someone money by being skipped. `why` is shown inline because a
 * checklist a buyer does not understand is a checklist they tick through.
 */

import type { ChecklistItem } from './types';

export const CHECKLIST: readonly ChecklistItem[] = [
  // --- Water ---------------------------------------------------------------
  {
    id: 'water.source',
    category: 'water',
    question: 'What is the actual water source — piped supply, borewell, or tankers?',
    why: 'Tanker dependence is a recurring cost that never appears in the price, and it rises every summer. Ask what the project spent on tankers last April.',
    evidenceField: 'locality.environment.waterStress',
    material: true,
  },
  {
    id: 'water.borewellDepth',
    category: 'water',
    question: 'If there is a borewell, how deep is it and has it been redrilled?',
    why: 'A borewell that has already been deepened once is telling you where the water table is going.',
    material: false,
  },
  {
    id: 'water.storage',
    category: 'water',
    question: 'How many days of storage does the project hold?',
    why: 'Under two days means any supply interruption is immediately your problem.',
    material: false,
  },

  // --- Power ---------------------------------------------------------------
  {
    id: 'power.backup',
    category: 'power',
    question: 'Is there generator backup for the flat, or only for common areas?',
    why: 'Common-area-only backup means lifts and lights work during a cut, but your home does not.',
    material: true,
  },
  {
    id: 'power.transformer',
    category: 'power',
    question: 'Is the transformer sized for full occupancy, or for current occupancy?',
    why: 'A transformer sized for a half-full project browns out when the rest move in.',
    material: false,
  },

  // --- Construction --------------------------------------------------------
  {
    id: 'construction.seepage',
    category: 'construction',
    question:
      'Any damp patches, efflorescence or water stains — especially on ceilings and bathroom walls?',
    why: 'Seepage is the single most expensive defect to fix after possession, and it is nearly always visible before.',
    material: true,
  },
  {
    id: 'construction.cracks',
    category: 'construction',
    question: 'Any cracks at beam-column junctions or around window frames?',
    why: 'Hairline plaster cracks are cosmetic. Cracks at structural junctions are not, and need an engineer.',
    material: true,
  },
  {
    id: 'construction.finishes',
    category: 'construction',
    question: 'Do the actual finishes match the specification sheet, not the sample flat?',
    why: 'A sample flat is a marketing asset. Get the written specification and check the delivered unit against it.',
    material: false,
  },

  // --- The unit ------------------------------------------------------------
  {
    id: 'unit.light',
    category: 'unit',
    question: 'How much daylight does the unit get, at the hour you actually visited?',
    why: 'Visit timing changes this completely. A north-facing unit seen at noon tells you nothing about 5pm.',
    evidenceField: 'property.facing',
    material: false,
  },
  {
    id: 'unit.ventilation',
    category: 'unit',
    question: 'Is there cross-ventilation, or do all openings face one side?',
    why: 'Single-aspect units need mechanical cooling far more of the year, which is a permanent running cost.',
    material: false,
  },
  {
    id: 'unit.noise',
    category: 'unit',
    question:
      'How loud is it inside with the windows shut — road, generator, pump room, lift shaft?',
    why: 'A unit above a pump room or beside a lift shaft is materially cheaper for a reason.',
    material: true,
  },
  {
    id: 'unit.carpetCheck',
    category: 'unit',
    question: 'Did you measure the carpet area, or accept the number on the sheet?',
    why: 'You are paying per square foot. Measure the main rooms and check them against the cost sheet.',
    evidenceField: 'property.carpetAreaSqFt',
    material: true,
  },

  // --- Surroundings --------------------------------------------------------
  {
    id: 'surroundings.adjacentPlots',
    category: 'surroundings',
    question: 'What is approved to be built on the empty plots around this one?',
    why: 'The view and the light you are paying a premium for may be someone else’s future tower. Check the sanctioned plans, not the sales pitch.',
    material: true,
  },
  {
    id: 'surroundings.waterlogging',
    category: 'surroundings',
    question:
      'Any sign of monsoon waterlogging — silt lines on compound walls, raised approach roads, storm drains?',
    why: 'A silt line on a boundary wall tells you how high the water came, whatever the brochure says about drainage.',
    evidenceField: 'locality.environment.floodRisk',
    material: true,
  },
  {
    id: 'surroundings.nuisance',
    category: 'surroundings',
    question: 'Anything nearby that runs at night — a quarry, a highway, a plant, a banquet hall?',
    why: 'A daytime visit will not find these. Ask a neighbour rather than the sales office.',
    material: false,
  },

  // --- Access --------------------------------------------------------------
  {
    id: 'access.roadWidth',
    category: 'access',
    question: 'How wide is the approach road, and is it a registered public road?',
    why: 'A narrow or private approach road limits both emergency access and resale, and can block a plan sanction.',
    material: true,
  },
  {
    id: 'access.commute',
    category: 'access',
    question: 'Did you drive the commute at peak hour, in the peak direction?',
    why: 'The map estimate and the Monday 9am reality are different numbers. Drive it before you decide.',
    evidenceField: 'locality.employment',
    material: true,
  },

  // --- Amenities -----------------------------------------------------------
  {
    id: 'amenities.delivered',
    category: 'amenities',
    question: 'Which advertised amenities are actually built and running today?',
    why: 'Amenities promised in a later phase often arrive late or not at all. Only count what you can walk into.',
    evidenceField: 'project.amenities',
    material: false,
  },
  {
    id: 'amenities.lifts',
    category: 'amenities',
    question: 'How many lifts serve how many flats per floor?',
    why: 'Two lifts for twelve flats a floor is a twenty-minute morning, every morning.',
    material: false,
  },
  {
    id: 'amenities.parking',
    category: 'amenities',
    question: 'Did you see the specific parking slot allotted to this unit?',
    why: 'Parking is frequently sold as a number and delivered as a stack slot or a corner you cannot turn into.',
    material: false,
  },

  // --- Legal on site -------------------------------------------------------
  {
    id: 'legal.reraBoard',
    category: 'legal',
    question: 'Is the RERA registration number displayed on site, and does it match the documents?',
    why: 'RERA requires the number to be displayed. A mismatch between the board and the paperwork is worth stopping over.',
    evidenceField: 'phase.rera.number',
    material: true,
  },
  {
    id: 'legal.occupancyCertificate',
    category: 'legal',
    question: 'For a completed project — have you seen the occupancy certificate?',
    why: 'Taking possession without an OC means the building is not legally occupiable, and utilities can be refused.',
    material: true,
  },
];

export const checklistFor = (category: string): readonly ChecklistItem[] =>
  CHECKLIST.filter((c) => c.category === category);

export const checklistItem = (id: string): ChecklistItem | undefined =>
  CHECKLIST.find((c) => c.id === id);
