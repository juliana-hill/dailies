// Fixed, curated asset library the editorial agent can attach to a cue instead of generating a
// fresh image or audio sting from scratch. Files live in Cloud Storage under a shared, non-project
// prefix (see LIBRARY_GCS_PREFIX) and get copied into the project's own asset path only when
// actually selected for a cue — see select_library_emoji / select_library_sfx in editorialAgent.ts.

export const LIBRARY_GCS_PREFIX = '_library';

export type LibraryEmoji = { id: string; emoji: string; label: string; fileName: string };
export const EMOJI_LIBRARY: LibraryEmoji[] = [
  { id: 'dizzy-face', emoji: '😵', label: 'dizzy face', fileName: 'dizzy-face_1f635.png' },
  { id: 'dotted-line-face', emoji: '🫥', label: 'dotted line face (fading out, awkward)', fileName: 'dotted-line-face_1fae5.png' },
  { id: 'downcast-face-with-sweat', emoji: '😓', label: 'downcast face with sweat (stressed, disappointed)', fileName: 'downcast-face-with-sweat_1f613.png' },
  { id: 'expressionless-face', emoji: '😑', label: 'expressionless face (deadpan)', fileName: 'expressionless-face_1f611.png' },
  { id: 'face-exhaling', emoji: '😮‍💨', label: 'face exhaling (relief, done with it)', fileName: 'face-exhaling_1f62e-200d-1f4a8.png' },
  { id: 'face-holding-back-tears', emoji: '🥹', label: 'face holding back tears (touched, proud)', fileName: 'face-holding-back-tears_1f979.png' },
  { id: 'face-savoring-food', emoji: '😋', label: 'face savoring food (delicious, satisfying)', fileName: 'face-savoring-food_1f60b.png' },
  { id: 'face-vomiting', emoji: '🤮', label: 'face vomiting (disgust)', fileName: 'face-vomiting_1f92e.png' },
  { id: 'face-with-bags-under-eyes', emoji: '🫩', label: 'face with bags under eyes (exhausted)', fileName: 'face-with-bags-under-eyes_1fae9.png' },
  { id: 'face-with-hand-over-mouth', emoji: '🤭', label: 'face with hand over mouth (oops, giggling)', fileName: 'face-with-hand-over-mouth_1f92d.png' },
  { id: 'face-with-monocle', emoji: '🧐', label: 'face with monocle (scrutinizing, skeptical)', fileName: 'face-with-monocle_1f9d0.png' },
  { id: 'face-with-raised-eyebrow', emoji: '🤨', label: 'face with raised eyebrow (suspicious, doubtful)', fileName: 'face-with-raised-eyebrow_1f928.png' },
  { id: 'face-with-spiral-eyes', emoji: '😵‍💫', label: 'face with spiral eyes (overwhelmed, dizzy)', fileName: 'face-with-spiral-eyes_1f635-200d-1f4ab.png' },
  { id: 'face-with-symbols-on-mouth', emoji: '🤬', label: 'face with symbols on mouth (frustrated, cursing)', fileName: 'face-with-symbols-on-mouth_1f92c.png' },
  { id: 'face-with-thermometer', emoji: '🤒', label: 'face with thermometer (sick, unwell)', fileName: 'face-with-thermometer_1f912.png' },
  { id: 'folded-hands', emoji: '🙏', label: 'folded hands (thank you, please)', fileName: 'folded-hands_1f64f.png' },
  { id: 'ghost', emoji: '👻', label: 'ghost (spooky, silly)', fileName: 'ghost_1f47b.png' },
  { id: 'grinning-face-with-sweat', emoji: '😅', label: 'grinning face with sweat (nervous relief)', fileName: 'grinning-face-with-sweat_1f605.png' },
  { id: 'hear-no-evil-monkey', emoji: '🙉', label: 'hear no evil monkey', fileName: 'hear-no-evil-monkey_1f649.png' },
  { id: 'hot-face', emoji: '🥵', label: 'hot face (overwhelmed, literally or figuratively hot)', fileName: 'hot-face_1f975.png' },
  { id: 'hugging-face', emoji: '🤗', label: 'hugging face (warm, welcoming)', fileName: 'hugging-face_1f917.png' },
  { id: 'loudly-crying-face', emoji: '😭', label: 'loudly crying face (overjoyed or devastated)', fileName: 'loudly-crying-face_1f62d.png' },
  { id: 'love-you-gesture', emoji: '🤟', label: 'love you gesture', fileName: 'love-you-gesture_1f91f.png' },
  { id: 'man-facepalming', emoji: '🤦‍♂️', label: 'man facepalming', fileName: 'man-facepalming_1f926-200d-2642-fe0f.png' },
  { id: 'melting-face', emoji: '🫠', label: 'melting face (embarrassed, overwhelmed)', fileName: 'melting-face_1fae0.png' },
  { id: 'nerd-face', emoji: '🤓', label: 'nerd face (technical, expert callout)', fileName: 'nerd-face_1f913.png' },
  { id: 'pile-of-poo', emoji: '💩', label: 'pile of poo (something went wrong, joke)', fileName: 'pile-of-poo_1f4a9.png' },
  { id: 'pleading-face', emoji: '🥺', label: 'pleading face (please, puppy eyes)', fileName: 'pleading-face_1f97a.png' },
  { id: 'raising-hands', emoji: '🙌', label: 'raising hands (celebration, success)', fileName: 'raising-hands_1f64c.png' },
  { id: 'rolling-on-the-floor-laughing', emoji: '🤣', label: 'rolling on the floor laughing', fileName: 'rolling-on-the-floor-laughing_1f923.png' },
  { id: 'see-no-evil-monkey', emoji: '🙈', label: 'see no evil monkey', fileName: 'see-no-evil-monkey_1f648.png' },
  { id: 'smiling-face-with-heart-eyes', emoji: '😍', label: 'smiling face with heart eyes (love it)', fileName: 'smiling-face-with-heart-eyes_1f60d.png' },
  { id: 'smiling-face-with-hearts', emoji: '🥰', label: 'smiling face with hearts (warm affection)', fileName: 'smiling-face-with-hearts_1f970.png' },
  { id: 'smiling-face', emoji: '☺️', label: 'smiling face (simple, content)', fileName: 'smiling-face_263a-fe0f.png' },
  { id: 'sneezing-face', emoji: '🤧', label: 'sneezing face', fileName: 'sneezing-face_1f927.png' },
  { id: 'speak-no-evil-monkey', emoji: '🙊', label: 'speak no evil monkey', fileName: 'speak-no-evil-monkey_1f64a.png' },
  { id: 'star-struck', emoji: '🤩', label: 'star struck (amazed, impressed)', fileName: 'star-struck_1f929.png' },
  { id: 'upside-down-face', emoji: '🙃', label: 'upside down face (sarcasm, irony)', fileName: 'upside-down-face_1f643.png' },
  { id: 'victory-hand', emoji: '✌️', label: 'victory hand', fileName: 'victory-hand_270c-fe0f.png' },
  { id: 'vulcan-salute', emoji: '🖖', label: 'vulcan salute', fileName: 'vulcan-salute_1f596.png' },
  { id: 'woman-facepalming', emoji: '🤦‍♀️', label: 'woman facepalming', fileName: 'woman-facepalming_1f926-200d-2640-fe0f.png' },
  { id: 'woozy-face', emoji: '🥴', label: 'woozy face (dazed, overwhelmed)', fileName: 'woozy-face_1f974.png' },
];

export type LibrarySfx = { id: string; label: string; fileName: string; cueType: 'pop' | 'laugh_track' | 'sting'; durationSeconds: number };
export const SFX_LIBRARY: LibrarySfx[] = [
  { id: 'ba-dum-tss', label: 'ba dum tss — classic rimshot punchline', fileName: 'adhimahadi-ba-dum-tss-8279.mp3', cueType: 'sting', durationSeconds: 1.94 },
  { id: '90s-laugh-to-clapping-outro', label: '90s sitcom laugh building into applause — good for a closing payoff', fileName: 'artificiallyinspired-90s-laugh-track-to-clapping-outro-564194.mp3', cueType: 'laugh_track', durationSeconds: 9.55 },
  { id: '90s-sitcom-laugh-track', label: '90s sitcom laugh track', fileName: 'artificiallyinspired-90s-sitcom-laugh-track-353985.mp3', cueType: 'laugh_track', durationSeconds: 3.97 },
  { id: '90s-sitcom-laugh-track-v2', label: '90s sitcom laugh track, alternate take', fileName: 'artificiallyinspired-90s-sitcom-laugh-track-v2-353986.mp3', cueType: 'laugh_track', durationSeconds: 3.97 },
  { id: 'sharp-pop', label: 'sharp, crisp UI pop', fileName: 'creatorshome-sharp-pop-328170.mp3', cueType: 'pop', durationSeconds: 1.02 },
  { id: 'bubble-pop', label: 'soft bubble pop', fileName: 'dragon-studio-bubble-pop-406640.mp3', cueType: 'pop', durationSeconds: 1.03 },
  { id: 'clean-minimal-pop', label: 'clean, minimal pop', fileName: 'dragon-studio-clean-minimal-pop-467466.mp3', cueType: 'pop', durationSeconds: 1.63 },
  { id: 'pop-1', label: 'quick pop, variant 1', fileName: 'dragon-studio-pop-402323.mp3', cueType: 'pop', durationSeconds: 0.72 },
  { id: 'pop-2', label: 'quick pop, variant 2', fileName: 'dragon-studio-pop-402324.mp3', cueType: 'pop', durationSeconds: 0.72 },
  { id: 'dun-dun-duuun', label: 'dun dun duuun — dramatic suspense/reveal sting', fileName: 'freesound_community-dun-dun-duuun-v01-105105.mp3', cueType: 'sting', durationSeconds: 8.33 },
  { id: 'summer-pop-dance-riff', label: 'upbeat summer pop-dance riff, ~16s — a full musical flourish, not a one-shot', fileName: 'jonasblakewood-summer-pop-dance-546975.mp3', cueType: 'sting', durationSeconds: 16.33 },
  { id: 'pop-reel', label: 'pop', fileName: 'soundreality-pop-423717.mp3', cueType: 'pop', durationSeconds: 1.97 },
  { id: 'pop-reverb-tail', label: 'pop with a reverb tail', fileName: 'soundreality-pop-reverb-423718.mp3', cueType: 'pop', durationSeconds: 3.94 },
  { id: 'bubble-pop-2', label: 'bubble pop, alternate', fileName: 'universfield-bubble-pop-06-351337.mp3', cueType: 'pop', durationSeconds: 1.06 },
  { id: 'comedy-drum-roll', label: 'comedy drum roll — suspense build before a reveal', fileName: 'universfield-comedy-drum-roll-242242.mp3', cueType: 'sting', durationSeconds: 1.34 },
];
