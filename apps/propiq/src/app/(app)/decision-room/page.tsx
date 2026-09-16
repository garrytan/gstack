import { permanentRedirect } from 'next/navigation';

/**
 * "Decision Room" is what the product calls the comparison surface, and it is
 * the label in the navigation, so people type and link that URL. The surface
 * itself lives at /compare. One canonical route, one redirect, rather than two
 * pages that can drift.
 */
export default function DecisionRoomAlias() {
  permanentRedirect('/compare');
}
