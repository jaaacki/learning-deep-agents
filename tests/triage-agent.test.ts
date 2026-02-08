import { describe, it, expect } from 'vitest';
import {
  parseTriageOutput,
  buildTriageMessage,
} from '../src/triage-agent.js';
import type { TriageOutput } from '../src/triage-agent.js';

// ── parseTriageOutput ───────────────────────────────────────────────────────

describe('parseTriageOutput', () => {
  it('parses a valid JSON response', () => {
    const input = JSON.stringify({
      issueType: 'bug',
      complexity: 'simple',
      relevantFiles: ['src/index.ts', 'src/config.ts'],
      shouldAnalyze: true,
      summary: 'A bug in the config loader.',
    });

    const result = parseTriageOutput(input);

    expect(result.issueType).toBe('bug');
    expect(result.complexity).toBe('simple');
    expect(result.relevantFiles).toEqual(['src/index.ts', 'src/config.ts']);
    expect(result.shouldAnalyze).toBe(true);
    expect(result.skipReason).toBeUndefined();
    expect(result.summary).toBe('A bug in the config loader.');
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const input = '```json\n{\n  "issueType": "feature",\n  "complexity": "moderate",\n  "relevantFiles": [],\n  "shouldAnalyze": true,\n  "summary": "A new feature request."\n}\n```';

    const result = parseTriageOutput(input);

    expect(result.issueType).toBe('feature');
    expect(result.complexity).toBe('moderate');
    expect(result.shouldAnalyze).toBe(true);
  });

  it('parses JSON with surrounding text', () => {
    const input = 'Here is my assessment:\n\n{"issueType": "docs", "complexity": "trivial", "relevantFiles": ["README.md"], "shouldAnalyze": false, "skipReason": "Just a typo", "summary": "Typo in README"}\n\nDone.';

    const result = parseTriageOutput(input);

    expect(result.issueType).toBe('docs');
    expect(result.complexity).toBe('trivial');
    expect(result.shouldAnalyze).toBe(false);
    expect(result.skipReason).toBe('Just a typo');
    expect(result.relevantFiles).toEqual(['README.md']);
  });

  it('returns fallback when no JSON found', () => {
    const result = parseTriageOutput('I could not analyze this issue.');

    expect(result.issueType).toBe('unknown');
    expect(result.complexity).toBe('moderate');
    expect(result.shouldAnalyze).toBe(true);
    expect(result.summary).toContain('could not be parsed');
  });

  it('returns fallback when JSON is malformed', () => {
    const result = parseTriageOutput('{ broken json !!!');

    expect(result.issueType).toBe('unknown');
    expect(result.shouldAnalyze).toBe(true);
  });

  it('normalizes invalid issueType to unknown', () => {
    const input = JSON.stringify({
      issueType: 'banana',
      complexity: 'simple',
      relevantFiles: [],
      shouldAnalyze: true,
      summary: 'Test',
    });

    const result = parseTriageOutput(input);
    expect(result.issueType).toBe('unknown');
  });

  it('normalizes invalid complexity to moderate', () => {
    const input = JSON.stringify({
      issueType: 'bug',
      complexity: 'impossible',
      relevantFiles: [],
      shouldAnalyze: true,
      summary: 'Test',
    });

    const result = parseTriageOutput(input);
    expect(result.complexity).toBe('moderate');
  });

  it('filters non-string entries from relevantFiles', () => {
    const input = JSON.stringify({
      issueType: 'bug',
      complexity: 'simple',
      relevantFiles: ['src/index.ts', 42, null, 'src/config.ts', true],
      shouldAnalyze: true,
      summary: 'Test',
    });

    const result = parseTriageOutput(input);
    expect(result.relevantFiles).toEqual(['src/index.ts', 'src/config.ts']);
  });

  it('defaults shouldAnalyze to true when not boolean', () => {
    const input = JSON.stringify({
      issueType: 'bug',
      complexity: 'simple',
      relevantFiles: [],
      shouldAnalyze: 'yes',
      summary: 'Test',
    });

    const result = parseTriageOutput(input);
    expect(result.shouldAnalyze).toBe(true);
  });

  it('handles missing fields gracefully', () => {
    const input = JSON.stringify({});

    const result = parseTriageOutput(input);

    expect(result.issueType).toBe('unknown');
    expect(result.complexity).toBe('moderate');
    expect(result.relevantFiles).toEqual([]);
    expect(result.shouldAnalyze).toBe(true);
    expect(result.summary).toBe('No summary provided.');
  });

  it('handles relevantFiles being a non-array', () => {
    const input = JSON.stringify({
      issueType: 'feature',
      complexity: 'complex',
      relevantFiles: 'src/index.ts',
      shouldAnalyze: true,
      summary: 'Test',
    });

    const result = parseTriageOutput(input);
    expect(result.relevantFiles).toEqual([]);
  });

  it('preserves skipReason when shouldAnalyze is false', () => {
    const input = JSON.stringify({
      issueType: 'question',
      complexity: 'trivial',
      relevantFiles: [],
      shouldAnalyze: false,
      skipReason: 'This is a question, not a bug.',
      summary: 'User asking about config format.',
    });

    const result = parseTriageOutput(input);
    expect(result.shouldAnalyze).toBe(false);
    expect(result.skipReason).toBe('This is a question, not a bug.');
  });

  it('handles all valid issueType values', () => {
    for (const type of ['bug', 'feature', 'docs', 'question', 'unknown']) {
      const input = JSON.stringify({
        issueType: type,
        complexity: 'simple',
        relevantFiles: [],
        shouldAnalyze: true,
        summary: 'Test',
      });
      expect(parseTriageOutput(input).issueType).toBe(type);
    }
  });

  it('handles all valid complexity values', () => {
    for (const level of ['trivial', 'simple', 'moderate', 'complex']) {
      const input = JSON.stringify({
        issueType: 'bug',
        complexity: level,
        relevantFiles: [],
        shouldAnalyze: true,
        summary: 'Test',
      });
      expect(parseTriageOutput(input).complexity).toBe(level);
    }
  });
});

// ── buildTriageMessage ──────────────────────────────────────────────────────

describe('buildTriageMessage', () => {
  it('includes issue number and title', () => {
    const msg = buildTriageMessage({
      number: 42,
      title: 'Fix login bug',
      body: 'Login fails when password has special chars',
      labels: ['bug'],
    });

    expect(msg).toContain('#42');
    expect(msg).toContain('Fix login bug');
  });

  it('includes issue body', () => {
    const msg = buildTriageMessage({
      number: 1,
      title: 'Test',
      body: 'Detailed description here',
      labels: [],
    });

    expect(msg).toContain('Detailed description here');
  });

  it('includes labels', () => {
    const msg = buildTriageMessage({
      number: 1,
      title: 'Test',
      body: 'Body',
      labels: ['bug', 'priority-high'],
    });

    expect(msg).toContain('bug, priority-high');
  });

  it('shows "none" when labels are empty', () => {
    const msg = buildTriageMessage({
      number: 1,
      title: 'Test',
      body: 'Body',
      labels: [],
    });

    expect(msg).toContain('Labels: none');
  });

  it('includes instruction to output JSON', () => {
    const msg = buildTriageMessage({
      number: 1,
      title: 'Test',
      body: 'Body',
      labels: [],
    });

    expect(msg).toContain('JSON');
  });
});
