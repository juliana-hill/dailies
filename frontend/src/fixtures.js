/** @typedef {import('../../shared/src/index.ts').AnalysisResult} AnalysisResult */
/** @typedef {import('../../shared/src/index.ts').RetentionInsight} RetentionInsight */

export const demoProject = { id: 'proj_demo_0812', title: 'Studio visit rough cut', duration: '01:14' };

export const demoCreator = {
  firstName: 'Juliana',
  fullName: 'Juliana Moon',
  email: 'juliana@example.com',
  initials: 'JM',
  plan: 'Studio plan',
};

export const dashboardProjects = [
  { id: 'proj_demo_0812', title: 'Studio visit rough cut', subtitle: 'A portrait of a loom maker', status: 'Ready to review', statusTone: 'ready', updated: 'Updated just now', duration: '01:14', sceneCount: 4, image: 'studio', insight: 'Carry the score through 00:29–00:36.' },
  { id: 'proj_62_moss', title: 'Moss after rain', subtitle: 'Field notes from the Pacific Northwest', status: 'Score in progress', statusTone: 'working', updated: 'Yesterday', duration: '02:08', sceneCount: 7, image: 'moss', insight: 'A quieter opening needs one clearer visual turn.' },
  { id: 'proj_41_clay', title: 'The clay room', subtitle: 'A small ceramics studio at dusk', status: 'Completed', statusTone: 'complete', updated: 'Aug 07', duration: '01:42', sceneCount: 6, image: 'clay', insight: 'The cut held attention through the final reveal.' },
];

export const dashboardSignal = {
  headline: 'Your strongest recent edits let the score carry through the first transition.',
  detail: 'Across four finished videos, the average local decline was 11% smaller when music continued through the first visual change.',
  videos: 4,
  movement: '11% smaller decline',
};

/** @type {AnalysisResult} */
export const demoAnalysis = {
  projectId: demoProject.id,
  durationSeconds: 74,
  scenes: [
    { id: 'scene-1', startSeconds: 0, endSeconds: 18, summary: 'A quiet walk into the studio establishes the room and the maker.', transcript: 'The first thing you notice is the sound of the looms.', mood: 'observant', energy: 0.28, pacingFlags: ['long setup'] },
    { id: 'scene-2', startSeconds: 18, endSeconds: 37, summary: 'Hands begin work; material detail gives the sequence purpose.', transcript: 'Every thread has a small decision inside it.', mood: 'tactile', energy: 0.52, pacingFlags: [] },
    { id: 'scene-3', startSeconds: 37, endSeconds: 55, summary: 'The maker explains the turning point behind the collection.', transcript: 'I stopped trying to make it look perfect.', mood: 'intimate', energy: 0.64, pacingFlags: ['dead air'] },
    { id: 'scene-4', startSeconds: 55, endSeconds: 74, summary: 'The finished pieces move through window light for a concise close.', transcript: 'That is when it started to feel like mine.', mood: 'resolved', energy: 0.76, pacingFlags: ['overlong shot'] },
  ],
  soundtrackBrief: { mood: 'Warm, curious, and lightly insistent', tempo: '92 BPM · unhurried pulse', instrumentation: 'Muted marimba, brushed kit, soft analogue bass', prompt: 'Instrumental editorial score. Begin with room tone and felt percussion, then introduce a warm pulse as the maker reveals the collection. Leave generous space for dialogue.' },
  soundtrackSegments: [
    { id: 'score-1', startSeconds: 0, endSeconds: 18, mood: 'observant', energy: 0.28, label: 'Room tone / arrival' },
    { id: 'score-2', startSeconds: 18, endSeconds: 37, mood: 'tactile', energy: 0.52, label: 'Hands at work' },
    { id: 'score-3', startSeconds: 37, endSeconds: 55, mood: 'intimate', energy: 0.64, label: 'The reveal' },
    { id: 'score-4', startSeconds: 55, endSeconds: 74, mood: 'resolved', energy: 0.76, label: 'Light / close' },
  ],
};

/** @type {RetentionInsight} */
export const demoInsight = {
  dropOffPositionRatio: 0.42,
  dropOffSeconds: 31,
  severityPercent: 18,
  observedEvidence: 'Three of the last four videos show their sharpest local decline between 40% and 44% of runtime. In each of those cuts, the music bed ends within three seconds of the decline.',
  inferredCause: 'The repeated music gap may be reducing momentum during a transition. This is a correlation, not proof of causation.',
  recommendationText: 'Carry the score through 00:29–00:36, then make the visual transition inside the bed rather than after it falls away.',
  suggestedAction: 'Extend the “Hands at work” pulse by 7 seconds and cut to the maker’s first decisive line at 00:34.',
  confidence: 'moderate',
  supportingVideoIds: ['v_8s1g', 'v_6mqe', 'v_43wl'],
  evidence: [
    { videoId: 'v_8s1g', title: 'Still life, slowly', durationSeconds: 68, positionRatio: 0.42, positionSeconds: 29, dropPercent: 17, nearbyEvents: ['music end', 'wide-to-detail cut'] },
    { videoId: 'v_6mqe', title: 'In the dye room', durationSeconds: 92, positionRatio: 0.43, positionSeconds: 40, dropPercent: 21, nearbyEvents: ['music end'] },
    { videoId: 'v_43wl', title: 'A dress in progress', durationSeconds: 76, positionRatio: 0.41, positionSeconds: 31, dropPercent: 16, nearbyEvents: ['music end', 'long static shot'] },
  ],
};

export const retentionCurve = [100, 98, 96, 94, 93, 90, 88, 86, 83, 78, 74, 72, 70, 69, 66, 64, 63, 61, 60, 58, 56];
