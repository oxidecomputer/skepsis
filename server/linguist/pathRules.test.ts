/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { classifyByPath, classifyByPaths } from './pathRules.ts'

describe('classifyByPath — generated', () => {
  it.each([
    // xcode_file? (extension-based)
    ['MainMenu.nib'],
    ['App.xcworkspace/contents.xcworkspacedata'],
    ['UserInterfaceState.xcuserstate'],
    // intellij_file?
    ['.idea/workspace.xml'],
    ['sub/.idea/misc.xml'],
    // cocoapods?
    ['Pods/Alamofire/Source/Alamofire.swift'],
    ['app/Pods/FBSDK/README.md'],
    // carthage_build?
    ['Carthage/Build/iOS/Alamofire.framework/Info.plist'],
    // node_modules?
    ['node_modules/react/index.js'],
    // go_lock?
    ['Gopkg.lock'],
    ['glide.lock'],
    // package_resolved?
    ['Package.resolved'],
    // lock files
    ['poetry.lock'],
    ['pdm.lock'],
    ['uv.lock'],
    ['pixi.lock'],
    ['deno.lock'],
    ['esy.lock'],
    ['my.esy.lock'],
    // npm_shrinkwrap_or_package_lock?
    ['npm-shrinkwrap.json'],
    ['package-lock.json'],
    // pnpm_lock?
    ['pnpm-lock.yaml'],
    // bun_lock?
    ['bun.lock'],
    ['bun.lockb'],
    ['sub/bun.lock'],
    // generated_yarn_plugnplay?
    ['.pnp.js'],
    ['.pnp.cjs'],
    ['sub/.pnp.loader.mjs'],
    // godeps?
    ['Godeps/foo.go'],
    // composer_lock?
    ['composer.lock'],
    // cargo
    ['Cargo.lock'],
    ['sub/Cargo.lock'],
    ['Cargo.toml.orig'],
    // flake_lock?
    ['flake.lock'],
    ['sub/flake.lock'],
    // bazel_lock?
    ['MODULE.bazel.lock'],
    // pipenv_lock?
    ['Pipfile.lock'],
    // terraform_lock?
    ['.terraform.lock.hcl'],
    ['sub/.terraform.lock.hcl'],
    // generated_graphql_relay?
    ['src/__generated__/Query.graphql.ts'],
    // generated_net_designer_file? (case insensitive)
    ['Form1.Designer.cs'],
    ['form1.designer.vb'],
    // generated_net_specflow_feature_file?
    ['Features/Login.feature.cs'],
    // generated_pascal_tlb?
    ['UnitName_TLB.pas'],
    // gradle_wrapper?
    ['gradlew'],
    ['sub/gradlew.bat'],
    // maven_wrapper?
    ['mvnw'],
    ['mvnw.cmd'],
    // htmlcov?
    ['htmlcov/index.html'],
  ])('%s is generated', (path) => {
    expect(classifyByPath(path).generated).toBe(true)
  })

  it('respects the go_vendor? heuristic', () => {
    // go_vendor? matches import paths under vendor/.
    expect(classifyByPath('vendor/github.com/pkg/errors/errors.go').generated).toBe(true)
    // But not plain `vendor/` entries that don't look like domains.
    expect(classifyByPath('vendor/foo').generated).toBeUndefined()
  })

  it('flags generated_by_zephir? only with the right extensions', () => {
    expect(classifyByPath('src/foo.zep.c').generated).toBe(true)
    expect(classifyByPath('src/foo.zep.h').generated).toBe(true)
    expect(classifyByPath('src/foo.zep.php').generated).toBe(true)
    expect(classifyByPath('src/foo.zep').generated).toBeUndefined()
  })
})

describe('classifyByPath — vendored', () => {
  it.each([
    ['cache/something.dat'],
    ['Dependencies/foo.c'],
    ['dist/bundle.js'],
    ['deps/openssl/openssl.c'],
    ['configure'],
    ['node_modules/pkg/file.js'],
    ['.yarn/releases/yarn.cjs'],
    ['bower_components/jquery/jquery.js'],
    ['third-party/lib.js'],
    ['3rd-party/lib.js'],
    ['vendor/foo.js'],
    ['vendors/lib.js'],
    ['extern/lib.js'],
    ['externals/lib.js'],
    ['app.min.js'],
    ['app.min.css'],
    ['style-min.js'],
    ['bootstrap.css'],
    ['bootstrap.min.css'],
    ['font-awesome.css'],
    ['jquery.js'],
    ['jquery-3.6.0.js'],
    ['d3.js'],
    ['d3.v5.min.js'],
    ['react.js'],
    ['react-dom.js'],
    ['Vagrantfile'],
    ['Jenkinsfile'],
    ['.DS_Store'],
    ['.github/workflows/ci.yml'],
    ['.vscode/settings.json'],
    ['.gitignore'],
    ['.gitattributes'],
    ['gradlew'],
    ['types/node.d.ts'],
    ['tests/fixtures/input.txt'],
    ['specs/fixtures/case.json'],
  ])('%s is vendored', (path) => {
    expect(classifyByPath(path).vendored).toBe(true)
  })
})

describe('classifyByPath — documentation', () => {
  it.each([
    ['docs/README.md'],
    ['Docs/index.html'],
    ['doc/manual.pdf'],
    ['Doc/overview.md'],
    ['Documentation/api.md'],
    ['pkg/Documentation/api.md'],
    ['man/cmd.1'],
    ['examples/basic.py'],
    ['demo/sample.html'],
    ['demos/sample.html'],
    ['samples/sample.py'],
    ['inst/doc/notes.md'],
    ['CITATION'],
    ['CITATION.cff'],
    ['CITATIONS.md'],
    ['CHANGELOG'],
    ['CHANGELOG.md'],
    ['CONTRIBUTING.md'],
    ['COPYING'],
    ['INSTALL.md'],
    ['LICENSE'],
    ['LICENSE.md'],
    ['LICENCE'],
    ['README'],
    ['README.md'],
    ['readme.txt'],
  ])('%s is documentation', (path) => {
    expect(classifyByPath(path).documentation).toBe(true)
  })
})

describe('classifyByPath — no match', () => {
  it.each([
    ['src/App.tsx'],
    ['server/main.ts'],
    ['cli.ts'],
    ['index.html'],
    ['package.json'],
  ])('%s returns no attributes', (path) => {
    expect(classifyByPath(path)).toEqual({})
  })
})

describe('classifyByPaths', () => {
  it('returns only files that matched a rule', () => {
    const result = classifyByPaths([
      'src/App.tsx',
      'pnpm-lock.yaml',
      'README.md',
      'node_modules/lib.js',
    ])
    expect(Object.keys(result).toSorted()).toEqual([
      'README.md',
      'node_modules/lib.js',
      'pnpm-lock.yaml',
    ])
    expect(result['pnpm-lock.yaml']?.generated).toBe(true)
    expect(result['README.md']?.documentation).toBe(true)
    // node_modules matches both generated and vendored in Linguist.
    expect(result['node_modules/lib.js']?.generated).toBe(true)
    expect(result['node_modules/lib.js']?.vendored).toBe(true)
  })
})
