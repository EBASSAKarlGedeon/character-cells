// Run: node --test test/strip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripInternalStates, countStateBlocks } from '../strip.js';

test('closed block is removed, prose kept', () => {
    const t = 'Before.\n\n<internal_states>\n<summary>A</summary>\nBOND 3\n</internal_states>\n\nAfter.';
    assert.equal(stripInternalStates(t), 'Before.\n\nAfter.');
});

test('GFX-wrapped block is removed with its markers', () => {
    const t = 'Hi.\n<!-- GFX_START -->\n<internal_states>x</internal_states>\n<!-- GFX_END -->\nBye.';
    assert.equal(stripInternalStates(t), 'Hi.\n\nBye.');
});

test('no closing tag, GFX_END present: block ends at GFX_END', () => {
    const t = 'Hi.\n<!-- GFX_START -->\n<internal_states>\nBOND 3\n<!-- GFX_END -->\nBye.';
    const r = stripInternalStates(t);
    assert.ok(!r.includes('BOND 3'));
    assert.ok(r.includes('Bye.') && r.includes('Hi.'));
    assert.ok(!r.includes('GFX'));
});

test('C6: no closing tag and no GFX_END: prose after the block survives', () => {
    const t = 'Intro prose.\n\n<internal_states>\n<summary>bonds</summary>\nBOND 3\n\nShe walked home and fell asleep.\n';
    const r = stripInternalStates(t);
    assert.ok(!r.includes('BOND 3'), 'block body removed');
    assert.ok(r.includes('Intro prose.'));
    assert.ok(r.includes('She walked home and fell asleep.'), 'prose after the block kept');
});

test('no closing tag, block runs to end of message: removed entirely', () => {
    const t = 'Prose.\n<internal_states>\nBOND 3\nSPARKS 1';
    assert.equal(stripInternalStates(t), 'Prose.');
});

test('closed block with a blank line inside is removed whole', () => {
    const t = 'A.\n<internal_states>\nline1\n\nline2\n</internal_states>\nB.';
    const r = stripInternalStates(t);
    assert.ok(!r.includes('line1') && !r.includes('line2'));
    assert.ok(r.includes('A.') && r.includes('B.'));
});

test('unclosed block does not swallow prose up to a LATER block closing tag', () => {
    const t = '<internal_states>\nfirst\n\nMiddle prose.\n\n<internal_states>second</internal_states>\nEnd.';
    const r = stripInternalStates(t);
    assert.ok(r.includes('Middle prose.'));
    assert.ok(!r.includes('first') && !r.includes('second'));
    assert.ok(r.includes('End.'));
});

test('C8: orphan GFX_START/GFX_END pair is removed', () => {
    assert.equal(stripInternalStates('Hi.\n<!-- GFX_START -->\n<!-- GFX_END -->\nBye.'), 'Hi.\n\nBye.');
});

test('non-state GFX is untouched', () => {
    const t = 'Look.\n<!-- GFX_START -->\n<div>phone</div>\n<!-- GFX_END -->';
    assert.equal(stripInternalStates(t), t);
});

test('countStateBlocks', () => {
    assert.equal(countStateBlocks('<internal_states>a</internal_states> <internal_states>'), 2);
    assert.equal(countStateBlocks(''), 0);
});
