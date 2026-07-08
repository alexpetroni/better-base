// Schema barrel: composes core tables with each module's schema file.
// Later phases add lines like: export * from '../../modules/blog/schema.ts';
export * from './core.ts';
export * from '../../modules/auth/schema.ts';
export * from '../../modules/media/schema.ts';
