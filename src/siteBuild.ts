import saved from '../build-version.json';
import type {SiteBuild} from './shared/siteMetadata';

declare const __SITE_BUILD__: SiteBuild;
export const siteBuild:SiteBuild=typeof __SITE_BUILD__==='undefined'?saved:__SITE_BUILD__;
export const developmentBuild=import.meta.env.DEV;
