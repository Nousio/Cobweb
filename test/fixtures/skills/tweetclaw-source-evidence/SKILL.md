---
name: tweetclaw-source-evidence
description: Review public X/Twitter evidence with TweetClaw links and explicit approval gates.
allowed-tools:
  - openclaw
  - web-search
disable-model-invocation: false
user-invokable: true
metadata:
  category: social-evidence
license: MIT
---

# TweetClaw Source Evidence

## When to Use

Use this fixture when validating a skill that references public social data tooling, package metadata, listing metadata, and local review policy resources.

Inputs: public profile, keyword, or tweet URL
Outputs: sourced evidence summary with approval status
Tools: openclaw, web-search

Read the [review policy](./references/review-policy.md).

Use [TweetClaw](https://github.com/Xquik-dev/tweetclaw) only for public X/Twitter evidence. Check the [npm package metadata](https://registry.npmjs.org/@xquik%2ftweetclaw) and [ClawHub listing](https://clawhub.ai/plugins/@xquik/tweetclaw) before suggesting an install.
