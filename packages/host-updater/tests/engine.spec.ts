/**
 * State-machine tests for the updater engine: durable persistence round-trip,
 * crash recovery from a mid-apply phase, and snapshot projection. Runs against a
 * throwaway temp repo so the real checkout's `.dsh/updater/state.json` is never
 * touched.
 *
 * @vitest-environment node
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveUpdaterConfig } from '../src/config.ts'
import {
  configView, initialEngineState, listBackups, persistState, readSnapshot,
  type EngineState,
} from '../src/engine.ts'
import { makeTempRepo } from './helpers.ts'

describe('engine persistence', () => {
  it('round-trips a full state through the durable file', () => {
    const repo = makeTempRepo('master')
    try {
      const config = resolveUpdaterConfig({ repoPath: repo.path })
      const state: EngineState = {
        ...initialEngineState(config),
        phase: 'update-available',
        upstreamSha: 'b'.repeat(40),
        currentSha: 'a'.repeat(40),
        currentVersion: '0.1.0-rc.5',
        upstreamVersion: '0.1.0-rc.7',
        behind: 7,
        stashCount: 2,
        conflictedFiles: ['src/main.ts'],
        logs: [{ at: '2026-08-17T00:00:00Z', level: 'info', message: 'check ok' }],
        error: null,
      }
      persistState(state, config)

      const reloaded = initialEngineState(config)
      expect(reloaded.phase).toBe('update-available')
      expect(reloaded.upstreamSha).toBe('b'.repeat(40))
      expect(reloaded.currentVersion).toBe('0.1.0-rc.5')
      expect(reloaded.upstreamVersion).toBe('0.1.0-rc.7')
      expect(reloaded.stashCount).toBe(2)
      expect(reloaded.conflictedFiles).toEqual(['src/main.ts'])
      // Logs are runtime-only by design: they are not restored on boot.
      expect(reloaded.logs).toEqual([])
    } finally {
      repo.cleanup()
    }
  })

  it('recovers a died mid-apply state into error with guidance', () => {
    const repo = makeTempRepo('master')
    try {
      const config = resolveUpdaterConfig({ repoPath: repo.path })
      const midApply: EngineState = {
        ...initialEngineState(config),
        phase: 'applying',
      }
      persistState(midApply, config)
      const recovered = initialEngineState(config)
      expect(recovered.phase).toBe('error')
      expect(recovered.error).toMatch(/did not finish/)
    } finally {
      repo.cleanup()
    }
  })

  it('survives a corrupt state file with defaults', () => {
    const repo = makeTempRepo('master')
    try {
      const config = resolveUpdaterConfig({ repoPath: repo.path })
      const stateFile = join(repo.path, '.dsh', 'updater', 'state.json')
      mkdirSync(join(repo.path, '.dsh', 'updater'), { recursive: true })
      writeFileSync(stateFile, '{ not json', 'utf8')
      const state = initialEngineState(config)
      expect(state.phase).toBe('idle')
      expect(state.error).toBeNull()
    } finally {
      repo.cleanup()
    }
  })

  it('projects a complete wire snapshot from state + config', () => {
    const repo = makeTempRepo('master')
    try {
      const config = resolveUpdaterConfig({ repoPath: repo.path, strategy: 'upstream-overlay' })
      const state: EngineState = {
        ...initialEngineState(config),
        phase: 'restart-pending',
        upstreamSha: 'b'.repeat(40),
        currentSha: 'a'.repeat(40),
        currentVersion: '0.1.0-rc.5',
        upstreamVersion: '0.1.0-rc.7',
        ahead: 0,
        behind: 3,
        pendingRestart: true,
        restartLast: '2026-08-17T00:00:00Z',
      }
      const snapshot = readSnapshot(state, config, [])
      expect(snapshot.phase).toBe('restart-pending')
      expect(snapshot.repoPath).toBe(repo.path)
      expect(snapshot.branch).toBe('master')
      expect(snapshot.behind).toBe(3)
      expect(snapshot.upstreamShort).toBe('b'.repeat(12))
      expect(snapshot.currentVersion).toBe('0.1.0-rc.5')
      expect(snapshot.upstreamVersion).toBe('0.1.0-rc.7')
      expect(snapshot.restart).toMatchObject({ pending: true, supervised: false, dead: false })
      expect(snapshot.config.strategy).toBe('upstream-overlay')
    } finally {
      repo.cleanup()
    }
  })
})

describe('configView', () => {
  it('exposes the effective config', () => {
    const config = resolveUpdaterConfig({ pollIntervalMs: 60_000, autoCheck: false })
    const view = configView(config)
    expect(view.pollIntervalMs).toBe(60_000)
    expect(view.autoCheck).toBe(false)
    expect(view.autoApply).toBe(false)
    expect(view.requireConsentApply).toBe(true)
    expect(view.requireConsentRestart).toBe(true)
  })

  it('rejects out-of-bounds values via the schema', () => {
    expect(() => resolveUpdaterConfig({ pollIntervalMs: 1 })).toThrow(/pollIntervalMs/)
    expect(() => resolveUpdaterConfig({ backupsKeep: 999 })).toThrow(/backupsKeep/)
  })
})

describe('listBackups', () => {
  it('returns [] when no backups exist', () => {
    const repo = makeTempRepo('master')
    try {
      const config = resolveUpdaterConfig({ repoPath: repo.path })
      expect(listBackups(config)).toEqual([])
    } finally {
      repo.cleanup()
    }
  })

  it('lists backup dirs newest-first with manifest metadata', () => {
    const repo = makeTempRepo('master')
    try {
      const config = resolveUpdaterConfig({ repoPath: repo.path })
      const dir = join(repo.path, '.dsh', 'updater', 'backups')
      mkdirSync(join(dir, '2026-08-17T00-00-00-000Z'), { recursive: true })
      mkdirSync(join(dir, '2026-08-18T00-00-00-000Z'), { recursive: true })
      writeFileSync(join(dir, '2026-08-18T00-00-00-000Z', 'manifest.json'), JSON.stringify({
        createdAt: '2026-08-18T00:00:00.000Z',
        headSha: 'c'.repeat(40),
        reason: 'apply',
      }))
      const backups = listBackups(config)
      expect(backups).toHaveLength(2)
      expect(backups[0].id).toBe('2026-08-18T00-00-00-000Z')
      expect(backups[0].headSha).toBe('c'.repeat(40))
    } finally {
      repo.cleanup()
    }
  })
})
