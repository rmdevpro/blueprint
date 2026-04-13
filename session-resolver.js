'use strict';

const fsp = require('fs/promises');
const { basename } = require('path');

module.exports = function createSessionResolver({
  db,
  safe,
  tmuxName,
  tmuxExists,
  sleep,
  logger,
  config,
}) {
  const pendingResolutions = new Map();
  const maxAttempts = config ? config.get('resolver.maxAttempts', 30) : 30;
  const sleepMs = config ? config.get('resolver.sleepMs', 2000) : 2000;

  async function resolveSessionId(tmpId, { tmux, sessionsDir, existingFiles, projectId }) {
    if (pendingResolutions.has(tmpId)) return;
    pendingResolutions.set(tmpId, true);

    try {
      for (let i = 0; i < maxAttempts; i++) {
        await sleep(sleepMs);
        try {
          const currentFiles = await fsp.readdir(sessionsDir);
          const newFiles = currentFiles.filter(
            (f) => f.endsWith('.jsonl') && !existingFiles.has(f),
          );
          if (newFiles.length >= 1) {
            const realId = basename(newFiles[0], '.jsonl');
            logger.info('Session ID resolved', {
              module: 'session-resolver',
              from: tmpId.substring(0, 12),
              to: realId.substring(0, 8),
            });

            const tmpSession = db.getSession(tmpId);
            db.upsertSession(realId, projectId, tmpSession?.name || null);
            if (tmpSession?.user_renamed) db.renameSession(realId, tmpSession.name);
            if (tmpSession?.notes) db.setSessionNotes(realId, tmpSession.notes);
            if (tmpSession?.state && tmpSession.state !== 'active')
              db.setSessionState(realId, tmpSession.state);

            db.deleteSession(tmpId);

            try {
              await safe.tmuxExecAsync(['rename-session', '-t', tmux, tmuxName(realId)]);
            } catch (renameErr) {
              if (
                renameErr.message &&
                (renameErr.message.includes('no server running') ||
                  renameErr.message.includes('error connecting to'))
              ) {
                /* expected: tmux server may have stopped */
              } else {
                logger.debug('tmux rename skipped (session may be dead)', {
                  module: 'session-resolver',
                  err: renameErr.message,
                });
              }
            }
            return;
          }
        } catch (err) {
          if (err.code === 'ENOENT') {
            if (i === 0) {
              logger.info('Waiting for sessions dir / JSONL to appear', {
                module: 'session-resolver',
                tmpId: tmpId.substring(0, 12),
              });
            }
            /* expected: sessions directory not created yet by claude CLI */
          } else {
            logger.error('Error scanning sessions dir', {
              module: 'session-resolver',
              op: 'resolveSessionId',
              err: err.message,
            });
          }
        }
      }

      logger.warn('Session resolution timed out — JSONL never appeared', {
        module: 'session-resolver',
        tmpId: tmpId.substring(0, 12),
        projectId,
      });
      if (!(await tmuxExists(tmux))) {
        db.deleteSession(tmpId);
        logger.info('Cleaned up orphaned temp session (tmux dead)', {
          module: 'session-resolver',
          tmpId: tmpId.substring(0, 12),
        });
      } else {
        logger.info('tmux still running; leaving temp session for later resolution', {
          module: 'session-resolver',
          tmpId: tmpId.substring(0, 12),
        });
      }
    } finally {
      pendingResolutions.delete(tmpId);
    }
  }

  async function resolveStaleNewSessions() {
    const dbProjects = db.getProjects();
    for (const dbProj of dbProjects) {
      const sessions = db.getSessionsForProject(dbProj.id);
      const staleSessions = sessions.filter((s) => s.id.startsWith('new_'));
      if (staleSessions.length === 0) continue;

      const sessionsDir = safe.findSessionsDir(dbProj.path);
      let files;
      try {
        files = await fsp.readdir(sessionsDir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          /* expected: project has no sessions dir yet — clean up all stale entries */
          for (const stale of staleSessions) {
            logger.info('Startup: removing orphaned temp session (no sessions dir)', {
              module: 'session-resolver',
              staleId: stale.id.substring(0, 15),
            });
            db.deleteSession(stale.id);
          }
        } else {
          logger.error('Cannot read sessions dir for stale check', {
            module: 'session-resolver',
            op: 'resolveStaleNewSessions',
            err: err.message,
          });
        }
        continue;
      }
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
      const dbSessionIds = new Set(sessions.map((s) => s.id));
      const unresolvedJsonls = jsonlFiles.filter((f) => !dbSessionIds.has(basename(f, '.jsonl')));

      for (const stale of staleSessions) {
        if (unresolvedJsonls.length > 0) {
          const jsonlFile = unresolvedJsonls.shift();
          const realId = basename(jsonlFile, '.jsonl');

          if (db.getSession(realId)) {
            logger.info('Startup: real session already exists, removing stale entry', {
              module: 'session-resolver',
              staleId: stale.id.substring(0, 15),
              realId: realId.substring(0, 8),
            });
            db.deleteSession(stale.id);
            continue;
          }

          logger.info('Startup: resolved stale session', {
            module: 'session-resolver',
            from: stale.id.substring(0, 15),
            to: realId.substring(0, 8),
          });
          db.upsertSession(realId, dbProj.id, stale.name || null);
          if (stale.user_renamed) db.renameSession(realId, stale.name);
          if (stale.notes) db.setSessionNotes(realId, stale.notes);
          if (stale.state && stale.state !== 'active') db.setSessionState(realId, stale.state);
          db.deleteSession(stale.id);
        } else {
          logger.info('Startup: removing orphaned temp session', {
            module: 'session-resolver',
            staleId: stale.id.substring(0, 15),
          });
          db.deleteSession(stale.id);
        }
      }
    }
  }

  return {
    resolveSessionId,
    resolveStaleNewSessions,
    __getPendingResolutions: () => pendingResolutions,
  };
};
