import { VideoSegmentStream, cachedVideoRanges } from '../../cvat-core/src/video-segments';
(window as any).segmentAPI = { VideoSegmentStream, cachedVideoRanges };
import * as originalVideo from '../../cvat-core/src/original-video';
(window as any).originalVideoAPI = originalVideo;
