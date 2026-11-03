import type { WorkflowDefinition } from './schema';

type Fact = WorkflowDefinition['requiredFacts'][number];
const text = (id: string, label: string): Fact => ({ id, label, kind: 'text', unit: null, min: null, max: null });
const measured = (id: string, label: string, unit: string, min: number, max: number): Fact =>
  ({ id, label, kind: 'number', unit, min, max });
const scope = (label: string): Fact => ({ id: 'scope_confirmed', label, kind: 'boolean', unit: null, min: null, max: null });

/** Different physical reasoning problems, with separate operator and visual checks. */
export const cameraWorkflows: WorkflowDefinition[] = [
  {
    id: 'harness_routing', iteration: 1, title: 'Route a branching sensor harness',
    summary: 'Keep branch identities, service loops and a declared routing graph consistent while the camera checks the next placement.',
    physicalScope: 'Disconnected, unpowered prototype sensor harnesses on a labelled bench routing board. The product is physical routing, not electrical commissioning.',
    requiredFacts: [
      scope('This is a disconnected, unpowered bench harness; I will use the declared operator resources.'),
      text('target_port_map', 'Declared branch-to-port map and required route through each anchor'),
      text('branch_labels', 'Actual labels on the trunk, every branch and every destination'),
      measured('minimum_bend_radius_mm', 'Minimum bend radius from the actual cable specification', 'mm', 0.1, 1000),
      measured('minimum_service_slack_mm', 'Minimum free service-loop length required at each destination', 'mm', 0, 2000),
      text('retention_method', 'Actual clips, combs or reversible ties available and how they are released'),
      text('operator_constraints', 'Available hands, permitted manipulations and prohibited holding or body supports'),
    ],
    steps: [
      {
        id: 'identify_harness', title: 'Ground the branch identities',
        instruction: 'Show the labelled trunk, branch ends and destination map. Resolve one unreadable or conflicting identity before suggesting a route.',
        visibleChecks: ['The active branch label and intended destination label are legible.', 'The referenced anchor or routing region is visible.', 'No visible label contradicts the declared port map.'],
        requiredFactIds: ['scope_confirmed', 'target_port_map', 'branch_labels', 'operator_constraints'],
        requiredConfirmations: [{ id: 'harness_unpowered', label: 'This is a disconnected, unpowered bench harness.' }, { id: 'harness_identity', label: 'I matched the actual branch labels to the declared destination map.' }],
        recoveryHint: 'If an identity is hidden or duplicated, label and expose that branch; do not infer its destination from colour alone.',
      },
      {
        id: 'route_harness', title: 'Route around the real constraints',
        measurements: [
          { id: 'observed_minimum_bend_radius_mm', label: 'Smallest actual bend radius inspected', unit: 'mm', factId: 'minimum_bend_radius_mm', relation: 'gte' },
          { id: 'observed_minimum_service_slack_mm', label: 'Smallest actual free service length inspected', unit: 'mm', factId: 'minimum_service_slack_mm', relation: 'gte' },
        ],
        instruction: 'Check one branch placement against the target path, the visible anchors and its neighbours. Ask for a ruler or specification reading when bend or slack limits matter.',
        visibleChecks: ['The active branch follows its declared anchor order.', 'Its path is not visibly trapped under an unintended branch or clip.', 'The destination and free service loop remain identifiable.'],
        requiredFactIds: ['scope_confirmed', 'target_port_map', 'minimum_bend_radius_mm', 'minimum_service_slack_mm', 'retention_method', 'operator_constraints'],
        requiredConfirmations: [{ id: 'harness_bend_measured', label: 'I checked actual bends against the declared minimum radius.' }, { id: 'harness_slack_measured', label: 'I measured the required free service length at each destination.' }],
        recoveryHint: 'Release only the affected reversible clip, expose the crossing and reroute that branch. Recheck bend and service length after moving an anchor.',
      },
      {
        id: 'retain_harness', title: 'Retain without hiding a routing error',
        instruction: 'Inspect the proposed retention point before closing its clip or tie. Keep labels and the service loop accessible for the final audit.',
        visibleChecks: ['The next retention point is visible and corresponds to the declared method.', 'The active label is not concealed by the retention placement.', 'No visible branch crosses into an unintended destination.'],
        requiredFactIds: ['scope_confirmed', 'retention_method', 'operator_constraints', 'target_port_map'],
        requiredConfirmations: [{ id: 'harness_no_pinching', label: 'I inspected for pinching and checked that the service loops remain free.' }, { id: 'harness_retention_released', label: 'I demonstrated the declared clip or tie can be released with permitted actions.' }],
        recoveryHint: 'If retention moves a branch or hides its identity, reopen that point and repeat the affected routing and measurement checks.',
      },
      {
        id: 'audit_harness', title: 'Audit the graph and release the work',
        measurements: [
          { id: 'observed_minimum_bend_radius_mm', label: 'Smallest actual bend radius after retention', unit: 'mm', factId: 'minimum_bend_radius_mm', relation: 'gte' },
          { id: 'observed_minimum_service_slack_mm', label: 'Smallest actual free service length after retention', unit: 'mm', factId: 'minimum_service_slack_mm', relation: 'gte' },
        ],
        instruction: 'Trace each labelled branch from trunk to destination. Treat unseen crossings and any required electrical tests as unresolved rather than guessing a pass.',
        visibleChecks: ['The shown branch reaches the destination named in the map.', 'The routing board or support does not visibly trap the finished harness.', 'The inspected labels and service loops are still visible after retention.'],
        requiredFactIds: ['scope_confirmed', 'target_port_map', 'branch_labels', 'minimum_bend_radius_mm', 'minimum_service_slack_mm', 'retention_method', 'operator_constraints'],
        requiredConfirmations: [{ id: 'harness_all_branches', label: 'I traced every branch to its specified destination, including hidden sections.' }, { id: 'harness_release_reset', label: 'I released the routed harness and reset the board without undeclared help.' }],
        recoveryHint: 'A wrong destination invalidates that branch audit. Reopen its retention, trace it physically and recheck all shared routing points.',
      },
    ],
    completionChecks: ['Every declared branch-to-port relationship is reviewed.', 'Bend and service-loop limits are checked by the operator.', 'Retention, release and reset use only declared resources.'],
    limitations: ['A camera cannot establish electrical continuity, insulation integrity or connector pinout.', 'Bend radius and free cable length require actual measurement.', 'A visible route is not evidence for an occluded branch segment.'],
  },
  {
    id: 'fragment_dry_fit', iteration: 2, title: 'Reconstruct a fragmented pattern',
    summary: 'Track irregular-piece identities, test edge hypotheses and recover from a plausible but wrong adjacency before making a reversible support layout.',
    physicalScope: 'Dry-fit reconstruction on replaceable printed-board or similar mock fragments with a declared reference. No adhesive, forced joining or treatment of irreplaceable objects.',
    requiredFacts: [
      scope('These are replaceable dry-fit mock fragments; no adhesive, forced fit or irreplaceable object is involved.'),
      text('reference_pattern', 'Reference outline and pattern, including any known missing region'),
      text('fragment_labels', 'Actual unique labels on the fragments and any known missing pieces'),
      measured('reference_width_mm', 'Measured reference outline width', 'mm', 1, 2000),
      measured('reference_height_mm', 'Measured reference outline height', 'mm', 1, 2000),
      measured('maximum_join_gap_mm', 'Maximum allowed dry-fit gap at a proposed join', 'mm', 0, 10),
      measured('maximum_outline_error_mm', 'Maximum permitted outline dimension error from the reference', 'mm', 0.01, 10),
      text('handling_constraints', 'Available hands, tools/backing, body-bracing restrictions and permitted handling; no adhesive or forced fit'),
    ],
    steps: [
      {
        id: 'inventory_fragments', title: 'Establish the pieces and the reference',
        instruction: 'Show the reference and labelled fragments. Identify a distinctive anchor piece; keep a missing piece or unreadable face explicitly unresolved.',
        visibleChecks: ['The active fragment label and a distinguishing edge or pattern feature are visible.', 'The referenced part of the target outline is available for comparison.', 'The active piece is separate enough to inspect its boundaries.'],
        requiredFactIds: ['scope_confirmed', 'reference_pattern', 'fragment_labels', 'handling_constraints'],
        requiredConfirmations: [{ id: 'fragments_replaceable', label: 'These are replaceable dry-fit mock fragments and the handling restrictions are correct.' }, { id: 'fragments_inventory', label: 'I recorded the real fragment inventory and known missing regions.' }],
        recoveryHint: 'Separate overlapping pieces and expose the relevant pattern face. Do not turn an unseen or missing piece into an invented match.',
      },
      {
        id: 'test_adjacency', title: 'Test one adjacency hypothesis',
        measurements: [{ id: 'observed_worst_join_gap_mm', label: 'Largest actual gap in this proposed join', unit: 'mm', factId: 'maximum_join_gap_mm', relation: 'lte' }],
        instruction: 'Compare one candidate pair using both the edge shape and printed pattern. Suggest only a reversible placement, and ask for a closer or alternate view when two matches remain plausible.',
        visibleChecks: ['Both candidate piece labels and the proposed shared edge are visible.', 'The visible pattern continues consistently across the proposed join.', 'The pieces do not visibly overlap or require a forced edge fit.'],
        requiredFactIds: ['scope_confirmed', 'reference_pattern', 'fragment_labels', 'maximum_join_gap_mm', 'handling_constraints'],
        requiredConfirmations: [{ id: 'fragment_edge_fit', label: 'I checked the actual edge fit without forcing or damaging either piece.' }, { id: 'fragment_gap_measured', label: 'I measured the proposed join gap against the declared limit.' }],
        recoveryHint: 'Move the uncertain candidate back to supply, retain its label and compare another edge. A pattern resemblance alone does not establish adjacency.',
      },
      {
        id: 'resolve_reconstruction', title: 'Resolve the outline and stabilise the layout',
        measurements: [
          { id: 'observed_outline_width_mm', label: 'Actual reconstructed outline width', unit: 'mm', factId: 'reference_width_mm', relation: 'within_tolerance', toleranceFactId: 'maximum_outline_error_mm' },
          { id: 'observed_outline_height_mm', label: 'Actual reconstructed outline height', unit: 'mm', factId: 'reference_height_mm', relation: 'within_tolerance', toleranceFactId: 'maximum_outline_error_mm' },
        ],
        instruction: 'Check the growing adjacency chain against the reference outline. If a local match breaks the overall pattern, undo that relationship before proposing a reversible backing or perimeter stop.',
        visibleChecks: ['The active adjacency chain agrees with the shown reference region.', 'The visible outer boundary does not contradict the reference outline.', 'The proposed support does not cover the active join or fragment identity.'],
        requiredFactIds: ['scope_confirmed', 'reference_pattern', 'reference_width_mm', 'reference_height_mm', 'maximum_outline_error_mm', 'handling_constraints'],
        requiredConfirmations: [{ id: 'fragment_global_outline', label: 'The complete dry-fit outline and pattern match the declared reference, including known missing regions.' }, { id: 'fragment_reversible_support', label: 'The actual backing or stops support the pieces without adhesive, forcing or hidden handling help.' }],
        recoveryHint: 'Undo the first conflicting adjacency, not an arbitrary distant piece. Reinspect neighbouring joins after changing the backing or stops.',
      },
      {
        id: 'review_reconstruction', title: 'Review joins, gaps and supported transfer',
        measurements: [
          { id: 'observed_worst_join_gap_mm', label: 'Largest actual gap across the reviewed joins', unit: 'mm', factId: 'maximum_join_gap_mm', relation: 'lte' },
          { id: 'observed_outline_width_mm', label: 'Actual reconstructed outline width after supported transfer', unit: 'mm', factId: 'reference_width_mm', relation: 'within_tolerance', toleranceFactId: 'maximum_outline_error_mm' },
          { id: 'observed_outline_height_mm', label: 'Actual reconstructed outline height after supported transfer', unit: 'mm', factId: 'reference_height_mm', relation: 'within_tolerance', toleranceFactId: 'maximum_outline_error_mm' },
        ],
        instruction: 'Review the remaining visible joins and missing regions. Keep the assembly on its declared backing; do not infer that the fragments form a self-supporting object.',
        visibleChecks: ['The inspected joins and fragment labels remain identifiable.', 'Any declared missing region remains represented as missing.', 'The shown backing supports the reconstructed layout rather than relying on a hand hidden from view.'],
        requiredFactIds: ['scope_confirmed', 'fragment_labels', 'maximum_join_gap_mm', 'reference_width_mm', 'reference_height_mm', 'maximum_outline_error_mm', 'handling_constraints'],
        requiredConfirmations: [{ id: 'fragment_all_joins', label: 'I inspected all proposed joins, gaps and known missing regions.' }, { id: 'fragment_supported_transfer', label: 'I checked the permitted supported transfer and reset without lifting by loose fragments.' }],
        recoveryHint: 'If a piece shifts during supported transfer, record the failure and repeat its adjacency, gap and support checks.',
      },
    ],
    completionChecks: ['Every claimed adjacency is reviewed against shape and reference pattern.', 'Actual gap and outline checks are recorded by the operator.', 'Missing pieces stay missing and the layout has a demonstrated reversible support method.'],
    limitations: ['This prototype does not provide conservation treatment or a restoration specification.', 'A single image cannot resolve hidden fracture geometry or establish a unique reconstruction.', 'Reference dimensions and gap measurements come from the operator, not pixel estimates.'],
  },
  {
    id: 'webbing_lacing', iteration: 3, title: 'Thread a reversible webbing closure',
    summary: 'Follow a labelled front/back slot path, expose hidden routing and recover a twist without restarting the whole assembly.',
    physicalScope: 'Non-loadbearing instrument-pouch or bench-fixture webbing prototypes with a known slot path. The result carries no load-retention or personal-support rating.',
    requiredFacts: [
      scope('This is a non-loadbearing webbing prototype, with no personal-support or secure-load claim.'),
      text('declared_slot_path', 'Exact slot order and front/back path from the reference design'),
      text('slot_labels', 'Actual labels on every slot and the fixed or free webbing end'),
      text('front_face_marker', 'Physical mark identifying the webbing front face and fixture front'),
      measured('webbing_width_mm', 'Measured webbing width for this prototype', 'mm', 0.5, 100),
      measured('minimum_tail_length_mm', 'Minimum free tail length required by the reference design', 'mm', 0, 2000),
      text('operator_constraints', 'Permitted threading/pulling actions and available hands or supports'),
    ],
    steps: [
      {
        id: 'identify_lacing', title: 'Identify the path and the two faces',
        instruction: 'Show the slot labels and face marks. Resolve the entry slot and the next front/back transition before asking the operator to thread anything.',
        visibleChecks: ['The active entry slot label is legible.', 'The marked webbing face and fixture face are distinguishable.', 'The shown entry corresponds to the declared slot path.'],
        requiredFactIds: ['scope_confirmed', 'declared_slot_path', 'slot_labels', 'front_face_marker', 'operator_constraints'],
        requiredConfirmations: [{ id: 'webbing_scope', label: 'This is a non-loadbearing prototype and the reference path is the intended design.' }, { id: 'webbing_faces', label: 'I identified the real front/back marks and the free webbing end.' }],
        recoveryHint: 'Add visible face marks or expose the entry slot. Do not substitute an assumed over/under pattern for an unreadable reference.',
      },
      {
        id: 'thread_segment', title: 'Thread the next constrained segment',
        instruction: 'Check one entry/exit pair at a time. Guide the free end through its next declared slot while keeping the marked face consistent.',
        visibleChecks: ['The current entry and exit slot are visible.', 'The active segment follows the declared local slot order.', 'The visible webbing face does not show an unexplained half twist.'],
        requiredFactIds: ['scope_confirmed', 'declared_slot_path', 'front_face_marker', 'webbing_width_mm', 'operator_constraints'],
        requiredConfirmations: [{ id: 'webbing_local_path', label: 'I physically checked the threaded slot sequence, including the current exit.' }, { id: 'webbing_clearance', label: 'The actual webbing passes through the slot using permitted actions without forced deformation.' }],
        recoveryHint: 'Withdraw only the free end to the last confirmed slot, expose the face mark and rethread that segment.',
      },
      {
        id: 'inspect_reverse_path', title: 'Expose the hidden return path',
        instruction: 'Request the rear or underside view needed to inspect the return segment. Keep the unseen face unknown and identify the earliest slot responsible for a twist or wrong return.',
        visibleChecks: ['The requested return-side segment is actually exposed.', 'Its shown slot labels agree with the declared return path.', 'No visible fold or half twist contradicts the marked face route.'],
        requiredFactIds: ['scope_confirmed', 'declared_slot_path', 'slot_labels', 'front_face_marker', 'operator_constraints'],
        requiredConfirmations: [{ id: 'webbing_reverse_inspected', label: 'I inspected the rear or underside route rather than assuming the front view proves it.' }, { id: 'webbing_twist_resolved', label: 'I checked the whole threaded path for twists and corrected any wrong return segment.' }],
        recoveryHint: 'Back out to the first incorrect face transition. Preserve the confirmed upstream path and recheck the newly exposed rear segment.',
      },
      {
        id: 'review_lacing', title: 'Review the tail and reversible operation',
        measurements: [{ id: 'observed_free_tail_mm', label: 'Actual free tail length after operation', unit: 'mm', factId: 'minimum_tail_length_mm', relation: 'gte' }],
        instruction: 'Inspect the final path and free end after the declared gentle operating motion. Request the actual tail-length reading; visible neatness is not a retention test.',
        visibleChecks: ['The shown final slot and free tail agree with the reference route.', 'The marked face remains consistent across the inspected segment.', 'The free end is accessible for the declared release action.'],
        requiredFactIds: ['scope_confirmed', 'declared_slot_path', 'minimum_tail_length_mm', 'operator_constraints'],
        requiredConfirmations: [{ id: 'webbing_tail_measured', label: 'I measured the actual free tail against the declared minimum.' }, { id: 'webbing_operation_reset', label: 'I checked the prototype opening/release and reset using only permitted actions.' }],
        recoveryHint: 'If operating the prototype pulls a tail through or introduces a twist, record that failure and recheck the affected path and tail reserve.',
      },
    ],
    completionChecks: ['The declared front/back slot sequence is inspected on both sides.', 'Twists and wrong return paths are resolved rather than hidden.', 'Actual tail reserve, reversible operation and reset are operator-reviewed.'],
    limitations: ['The camera cannot establish friction, tensile strength or secure retention.', 'An unseen rear path cannot pass from front-view evidence alone.', 'This profile does not validate lifting, climbing, restraint or personal-support equipment.'],
  },
  {
    id: 'gasket_seating', iteration: 4, title: 'Seat a compliant gasket',
    summary: 'Track a deformable ring around a labelled channel, recover rolled or displaced sections and separate visible seating from measured or tactile checks.',
    physicalScope: 'Dry, unpowered demo housings with a known matched gasket and channel. Guidance concerns placement; it does not establish a pressure, water or chemical seal.',
    requiredFacts: [
      scope('This is dry placement in an unpowered demo housing, without a pressure or sealing claim.'),
      text('matched_part_ids', 'Actual matched gasket and channel/housing identifiers'),
      text('specified_seating_method', 'Reference seating method and prohibited substitutions or stretching'),
      text('quadrant_labels', 'Actual reference marks for the four channel quadrants and gasket face'),
      measured('maximum_proud_height_mm', 'Maximum permitted standing-proud discontinuity from the reference', 'mm', 0, 10),
      text('inspection_method', 'Actual gauge, ruler or permitted tactile inspection used to review seating'),
      text('operator_constraints', 'Available hands and allowed seating, holding and release actions'),
    ],
    steps: [
      {
        id: 'identify_gasket', title: 'Match the ring, channel and face',
        instruction: 'Show the matched part marks and channel reference. Ask for the correct part or orientation when the visible profile conflicts; do not solve a mismatch by inventing extra stretching or force.',
        visibleChecks: ['The active channel quadrant and gasket face mark are visible.', 'The shown part marks do not contradict the declared matched pair.', 'The starting section is exposed enough to inspect its orientation.'],
        requiredFactIds: ['scope_confirmed', 'matched_part_ids', 'specified_seating_method', 'quadrant_labels', 'operator_constraints'],
        requiredConfirmations: [{ id: 'gasket_matched', label: 'I verified the actual gasket/channel pair and reference seating method.' }, { id: 'gasket_dry_scope', label: 'This is a dry, unpowered placement trial without a pressure or sealing claim.' }],
        recoveryHint: 'Expose the profile or replace the mismatched part. Keep the section unconfirmed until its actual identity and orientation are resolved.',
      },
      {
        id: 'seat_starting_quadrants', title: 'Seat without rolling the visible profile',
        instruction: 'Inspect one starting quadrant before the next permitted seating action. Watch the marked face and adjoining section for a roll or a section pulled out of its channel.',
        visibleChecks: ['The active gasket section visibly follows its channel.', 'Its visible face mark does not show an unexplained roll.', 'The adjoining shown section has not visibly lifted out during seating.'],
        requiredFactIds: ['scope_confirmed', 'specified_seating_method', 'quadrant_labels', 'operator_constraints'],
        requiredConfirmations: [{ id: 'gasket_start_inspected', label: 'I inspected the actual starting quadrants and hidden contact surfaces using the declared method.' }, { id: 'gasket_permitted_actions', label: 'I used only the declared seating and holding actions without undocumented stretching.' }],
        recoveryHint: 'Release the affected section using the reference method, restore its face orientation and recheck adjoining quadrants.',
      },
      {
        id: 'resolve_final_quadrants', title: 'Resolve the final compliant section',
        instruction: 'Inspect the remaining quadrant and its neighbours before accepting the final fit. A lifted, buckled or rolled section calls for local recovery, not additional unconfirmed force.',
        visibleChecks: ['The final active section and neighbouring channel are exposed.', 'No visible buckle, crossing or rolled face remains in the inspected section.', 'The shown earlier section remains located after the latest action.'],
        requiredFactIds: ['scope_confirmed', 'specified_seating_method', 'quadrant_labels', 'operator_constraints'],
        requiredConfirmations: [{ id: 'gasket_all_quadrants', label: 'I inspected all four actual quadrants and corrected displaced or rolled sections.' }, { id: 'gasket_no_hidden_substitution', label: 'I did not add an undeclared tool, adhesive, shim or holding resource.' }],
        recoveryHint: 'Undo the smallest affected section, revisit the previous confirmed quadrant and inspect the neighbouring contact surfaces again.',
      },
      {
        id: 'review_dry_seating', title: 'Measure and review the dry seating',
        measurements: [{ id: 'observed_maximum_proud_height_mm', label: 'Largest actual standing-proud discontinuity inspected', unit: 'mm', factId: 'maximum_proud_height_mm', relation: 'lte' }],
        instruction: 'Ask for the declared gauge or inspection result around the full perimeter. Keep hidden compression and any sealing performance unresolved by camera-only evidence.',
        visibleChecks: ['The inspected perimeter section remains in the intended channel.', 'The actual inspection point or reference gauge position is shown.', 'No visible section has moved out during the declared release of the holding hand.'],
        requiredFactIds: ['scope_confirmed', 'maximum_proud_height_mm', 'inspection_method', 'operator_constraints'],
        requiredConfirmations: [{ id: 'gasket_height_measured', label: 'I checked the full perimeter with the declared method against the allowed standing-proud limit.' }, { id: 'gasket_release_reviewed', label: 'I reviewed dry placement after releasing temporary holding; I am not claiming a leak or pressure test.' }],
        recoveryHint: 'Record the actual out-of-limit section and return to local seating. A clean-looking overview cannot override a failed physical inspection.',
      },
    ],
    completionChecks: ['The actual matched part, face and four quadrants are reviewed.', 'The operator records the declared full-perimeter seating inspection.', 'Dry placement remains stable after temporary holding is released.'],
    limitations: ['Images do not establish compression, insertion force, seal integrity or material compatibility.', 'The actual part pairing, reference method and physical gauge result remain operator facts.', 'A dry-placement review is not a leak, pressure or environmental qualification.'],
  },
  {
    id: 'gravity_fluidics', iteration: 5, title: 'Debug a gravity-fed manifold',
    summary: 'Trace a labelled tubing graph, inspect kinks and persistent bubbles, then use observed water progression and an actual collection reading to review the result.',
    physicalScope: 'Open, water-only, gravity-fed benchtop demonstration rigs with labelled tubes/ports and an open collector. No pump, sealed pressure source, chemical or patient connection.',
    requiredFacts: [
      scope('This is an open water-only gravity bench rig, with no pump, sealed source, chemicals or patient connection.'),
      text('target_port_map', 'Declared source, junction, branch and collector connections'),
      text('tube_port_labels', 'Actual unique labels on every tube end, port and collector'),
      measured('reservoir_head_mm', 'Measured vertical water-level head above the declared outlet', 'mm', 1, 1000),
      measured('test_duration_s', 'Declared timed collection interval', 's', 5, 300),
      measured('minimum_collected_ml', 'Minimum water collection required over that interval', 'mL', 0.1, 2000),
      text('operator_constraints', 'Permitted placement, clamp, tubing, observation and reset actions'),
    ],
    steps: [
      {
        id: 'map_fluidic_graph', title: 'Ground the port graph before flow',
        instruction: 'Show the labelled dry rig and target map. Trace one tube from its actual source to destination and expose a hidden or ambiguous junction before adding flow.',
        visibleChecks: ['The active tube-end and port labels are legible.', 'The shown connection agrees with the declared target graph.', 'The inspected junction is exposed rather than inferred through another tube.'],
        requiredFactIds: ['scope_confirmed', 'target_port_map', 'tube_port_labels', 'operator_constraints'],
        requiredConfirmations: [{ id: 'fluidics_open_water_scope', label: 'This is an open water-only gravity rig with no pump, sealed pressure source or patient connection.' }, { id: 'fluidics_actual_graph', label: 'I traced every actual tube connection, including hidden junctions, against the target map.' }],
        recoveryHint: 'Stop introducing water, expose the uncertain tube end and relabel it. Do not infer connectivity from similar tube colours.',
      },
      {
        id: 'prepare_gravity_route', title: 'Prepare the real gravity path',
        instruction: 'Inspect one suspected kink, pinched clip or conflicting route. Ask for the actual vertical head reading; a camera perspective cannot supply that measurement.',
        visibleChecks: ['The active tubing path and its next clip or bend are visible.', 'No visible kink or closed pinch contradicts the intended route.', 'The shown outlet reaches the declared open collector.'],
        requiredFactIds: ['scope_confirmed', 'target_port_map', 'reservoir_head_mm', 'operator_constraints'],
        requiredConfirmations: [{ id: 'fluidics_head_measured', label: 'I measured the actual water-level head relative to the declared outlet.' }, { id: 'fluidics_route_supported', label: 'I inspected the real tubing route, collector and available support without hidden pinching.' }],
        recoveryHint: 'Restore the declared route or support the affected section, then remeasure the head if a reservoir or outlet moved.',
      },
      {
        id: 'observe_water_progression', title: 'Observe progression and investigate a blockage',
        instruction: 'Use a fresh view to inspect water progression, a persistent visible bubble or a suspected unintended outlet. Ask the operator what changed since the previous check; do not estimate a flow rate from one still.',
        visibleChecks: ['The inspected fluid front or relevant junction is actually visible.', 'Visible water follows the declared branch rather than an unintended outlet.', 'The inspected area has no visible uncontrolled escape that contradicts the test.'],
        requiredFactIds: ['scope_confirmed', 'target_port_map', 'tube_port_labels', 'test_duration_s', 'operator_constraints'],
        requiredConfirmations: [{ id: 'fluidics_progress_observed', label: 'I observed actual water progression over time rather than treating a still image as proof of flow.' }, { id: 'fluidics_no_hidden_escape', label: 'I inspected the complete rig and collector for unintended escape or disconnected paths.' }],
        recoveryHint: 'Pause the gravity feed using the declared method, inspect the local obstruction and resume only after the affected graph and head checks are repeated.',
      },
      {
        id: 'review_collection_reset', title: 'Read collection and reset the rig',
        measurements: [{ id: 'observed_collected_volume_ml', label: 'Actual collected volume over the declared interval', unit: 'mL', factId: 'minimum_collected_ml', relation: 'gte' }],
        instruction: 'Request the timed interval and graduated-collector reading. Record an out-of-limit result as a failure to investigate; do not turn visible motion into a quantitative performance claim.',
        visibleChecks: ['The declared collector and its reading region are shown.', 'The inspected outlet still belongs to the declared graph.', 'The shown tubing and collector remain supported through the declared stop/reset action.'],
        requiredFactIds: ['scope_confirmed', 'test_duration_s', 'minimum_collected_ml', 'operator_constraints'],
        requiredConfirmations: [{ id: 'fluidics_collection_measured', label: 'I timed the declared interval, read the actual collected volume and checked it against the required minimum.' }, { id: 'fluidics_reset_reviewed', label: 'I stopped, emptied and reset the open demonstration rig using only the declared actions.' }],
        recoveryHint: 'Record the actual time/volume shortfall and revisit a specific wrong branch, kink, bubble or head change. Keep the failed observation in the record.',
      },
    ],
    completionChecks: ['The complete labelled connection graph is physically reviewed.', 'Actual progression, unintended escape and the timed collection result are operator-reviewed.', 'The open rig stops and resets using the declared method.'],
    limitations: ['A still image does not establish flow rate, hidden connectivity or absence of leaks.', 'Head, time and collected volume are actual operator measurements; the camera does not certify them.', 'This profile is not a pressurised, chemical, sterile or medical fluid-system procedure.'],
  },
];

export function cameraWorkflow(id: string): WorkflowDefinition | undefined {
  return cameraWorkflows.find(workflow => workflow.id === id);
}

/** Offline/API fixtures only. Never prefill these as real operator measurements. */
export const syntheticCameraFacts: Record<string, Record<string, string | number | boolean>> = {
  harness_routing: {
    scope_confirmed: true,
    target_port_map: 'Synthetic fixture: TRUNK branches A/B/C route through anchors L/M/R to ports P1/P2/P3 respectively.',
    branch_labels: 'Synthetic TRUNK, A, B, C, L, M, R, P1, P2, P3.',
    minimum_bend_radius_mm: 10, minimum_service_slack_mm: 20,
    retention_method: 'Synthetic reversible open combs and reusable clips.',
    operator_constraints: 'Hypothetical right-hand bench operation; no helper or body bracing.',
  },
  fragment_dry_fit: {
    scope_confirmed: true,
    reference_pattern: 'Synthetic replaceable six-piece printed rectangle with a continuous blue diagonal; no missing region.',
    fragment_labels: 'Synthetic F1, F2, F3, F4, F5, F6.',
    reference_width_mm: 180, reference_height_mm: 120, maximum_join_gap_mm: 1, maximum_outline_error_mm: 0.5,
    handling_constraints: 'Hypothetical right-hand handling of printed-board pieces on a loose backing; no helper/body bracing, adhesive or forced fit; transfer only on backing.',
  },
  webbing_lacing: {
    scope_confirmed: true,
    declared_slot_path: 'Synthetic reference: enter S1 from front, return S2 from rear, enter S3 from front, return S4 from rear.',
    slot_labels: 'Synthetic S1, S2, S3, S4 and FREE END.',
    front_face_marker: 'Synthetic blue line marks the webbing front; FRONT marks the board.',
    webbing_width_mm: 20, minimum_tail_length_mm: 30,
    operator_constraints: 'Hypothetical right-hand non-loadbearing bench prototype; reversible threading only.',
  },
  gasket_seating: {
    scope_confirmed: true,
    matched_part_ids: 'Synthetic matched G1 ring and H1 demo channel.',
    specified_seating_method: 'Synthetic dry placement by quadrant; no stretching, adhesive or extra shims.',
    quadrant_labels: 'Synthetic Q1, Q2, Q3, Q4 and gasket TOP mark.',
    maximum_proud_height_mm: 0.5,
    inspection_method: 'Hypothetical reference gauge and direct perimeter inspection; never infer its result from pixels.',
    operator_constraints: 'Hypothetical right-hand dry, unpowered bench placement with permitted temporary supports only.',
  },
  gravity_fluidics: {
    scope_confirmed: true,
    target_port_map: 'Synthetic open water reservoir R routes via junction J to branch A and open collector C; no other outlet.',
    tube_port_labels: 'Synthetic R, J, A, C and labelled tube ends R-J, J-A, A-C.',
    reservoir_head_mm: 150, test_duration_s: 30, minimum_collected_ml: 10,
    operator_constraints: 'Hypothetical water-only gravity bench rig; open collector, no pump or sealed source; pause at reservoir clamp.',
  },
};

export const cameraSyntheticFacts = syntheticCameraFacts;

/** Synthetic test values only; never an operator reading or a measured camera result. */
export function syntheticCameraMeasurements(workflowId: string, stepId: string): Record<string, number> {
  const step = cameraWorkflow(workflowId)?.steps.find(candidate => candidate.id === stepId);
  const facts = syntheticCameraFacts[workflowId];
  return Object.fromEntries((step?.measurements || []).flatMap(measurement => {
    const limit = facts?.[measurement.factId];
    if (typeof limit !== 'number') return [];
    return [[measurement.id, measurement.relation === 'within_tolerance' ? limit : measurement.relation === 'gte' ? limit + 1 : limit / 2]];
  }));
}
