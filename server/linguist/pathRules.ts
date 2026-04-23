/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Linguist's path-based rules for generated, vendored, and documentation
 * files — the ones that can be decided from the filename alone, without
 * reading the file's content.
 *
 * Ported from:
 *   github-linguist/linguist @ 537297cdae3ab05f8d5dd1c03627a5bd73707b19
 *   - lib/linguist/generated.rb (name-based checks)
 *   - lib/linguist/vendor.yml
 *   - lib/linguist/documentation.yml
 *
 * Content-based Linguist rules (source maps, protobuf, etc.) live in
 * `contentRules.ts`.
 */

import type { FileAttrs } from '../../shared/types.ts'

// --- Generated (path-based subset of generated.rb) ---

const GENERATED_EXTENSIONS = new Set([
  // xcode_file?
  '.nib',
  '.xcworkspacedata',
  '.xcuserstate',
])

const GENERATED_PATH_PATTERNS: string[] = [
  // intellij_file?
  '(?:^|/)\\.idea/',
  // cocoapods?
  '(^Pods|/Pods)/',
  // carthage_build?
  '(^|/)Carthage/Build/',
  // node_modules?
  'node_modules/',
  // go_vendor?
  'vendor/((?!-)[-0-9A-Za-z]+(?<!-)\\.)+(com|edu|gov|in|me|net|org|fm|io)',
  // go_lock?
  '(Gopkg|glide)\\.lock',
  // package_resolved?
  'Package\\.resolved',
  // poetry_lock?
  'poetry\\.lock',
  // pdm_lock?
  'pdm\\.lock',
  // uv_lock?
  'uv\\.lock',
  // pixi_lock?
  'pixi\\.lock',
  // esy_lock?
  '(^|/)(\\w+\\.)?esy\\.lock$',
  // deno_lock?
  'deno\\.lock',
  // npm_shrinkwrap_or_package_lock?
  'npm-shrinkwrap\\.json',
  'package-lock\\.json',
  // pnpm_lock?
  'pnpm-lock\\.yaml',
  // bun_lock?
  '(?:^|/)bun\\.lockb?$',
  // generated_yarn_plugnplay?
  '(^|/)\\.pnp\\..*$',
  // godeps?
  'Godeps/',
  // composer_lock?
  'composer\\.lock',
  // generated_by_zephir?
  '.\\.zep\\.(?:c|h|php)$',
  // cargo_lock?
  'Cargo\\.lock',
  // cargo_orig?
  'Cargo\\.toml\\.orig',
  // flake_lock?
  '(^|/)flake\\.lock$',
  // bazel_lock?
  '(^|/)MODULE\\.bazel\\.lock$',
  // pipenv_lock?
  'Pipfile\\.lock',
  // terraform_lock?
  '(?:^|/)\\.terraform\\.lock\\.hcl$',
  // generated_graphql_relay?
  '__generated__/',
  // generated_pascal_tlb?  (case-insensitive — handled below)
  // generated_net_designer_file?  (case-insensitive — handled below)
  // generated_net_specflow_feature_file?  (case-insensitive — handled below)
  // gradle_wrapper?  (case-insensitive — handled below)
  // maven_wrapper?  (case-insensitive — handled below)
  // htmlcov?
  '(?:^|/)htmlcov/',
]

const GENERATED_PATH_PATTERNS_CI: string[] = [
  // generated_net_designer_file?
  '\\.designer\\.(cs|vb)$',
  // generated_net_specflow_feature_file?
  '\\.feature\\.cs$',
  // generated_pascal_tlb?
  '_tlb\\.pas$',
  // gradle_wrapper?
  '(?:^|/)gradlew(?:\\.bat)?$',
  // maven_wrapper?
  '(?:^|/)mvnw(?:\\.cmd)?$',
]

const GENERATED_REGEXES: RegExp[] = [
  ...GENERATED_PATH_PATTERNS.map((p) => new RegExp(p)),
  ...GENERATED_PATH_PATTERNS_CI.map((p) => new RegExp(p, 'i')),
]

function hasGeneratedExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf('/')
  const base = lastSlash === -1 ? path : path.slice(lastSlash + 1)
  const dot = base.lastIndexOf('.')
  if (dot === -1) return false
  return GENERATED_EXTENSIONS.has(base.slice(dot))
}

// --- Vendor (vendor.yml, 168 patterns) ---

const VENDOR_PATTERNS: string[] = [
  '(^|/)cache/',
  '^[Dd]ependencies/',
  '(^|/)dist/',
  '^deps/',
  '(^|/)configure$',
  '(^|/)config\\.guess$',
  '(^|/)config\\.sub$',
  '(^|/)aclocal\\.m4',
  '(^|/)libtool\\.m4',
  '(^|/)ltoptions\\.m4',
  '(^|/)ltsugar\\.m4',
  '(^|/)ltversion\\.m4',
  '(^|/)lt~obsolete\\.m4',
  '(^|/)dotnet-install\\.(ps1|sh)$',
  '(^|/)cpplint\\.py',
  '(^|/)node_modules/',
  '(^|/)\\.yarn/releases/',
  '(^|/)\\.yarn/plugins/',
  '(^|/)\\.yarn/sdks/',
  '(^|/)\\.yarn/versions/',
  '(^|/)\\.yarn/unplugged/',
  '(^|/)_esy$',
  '(^|/)bower_components/',
  '^rebar$',
  '(^|/)erlang\\.mk',
  '(^|/)Godeps/_workspace/',
  '(^|/)testdata/',
  '(^|/)\\.indent\\.pro',
  '(\\.|-)min\\.(js|css)$',
  '([^\\s]*)import\\.(css|less|scss|styl)$',
  '(^|/)bootstrap([^/.]*)(\\..*)?\\.(js|css|less|scss|styl)$',
  '(^|/)custom\\.bootstrap([^\\s]*)(js|css|less|scss|styl)$',
  '(^|/)font-?awesome\\.(css|less|scss|styl)$',
  '(^|/)font-?awesome/.*\\.(css|less|scss|styl)$',
  '(^|/)foundation\\.(css|less|scss|styl)$',
  '(^|/)normalize\\.(css|less|scss|styl)$',
  '(^|/)skeleton\\.(css|less|scss|styl)$',
  '(^|/)[Bb]ourbon/.*\\.(css|less|scss|styl)$',
  '(^|/)animate\\.(css|less|scss|styl)$',
  '(^|/)materialize\\.(css|less|scss|styl|js)$',
  '(^|/)select2/.*\\.(css|scss|js)$',
  '(^|/)bulma\\.(css|sass|scss)$',
  '(3rd|[Tt]hird)[-_]?[Pp]arty/',
  '(^|/)vendors?/',
  '(^|/)[Ee]xtern(als?)?/',
  '(^|/)[Vv]+endor/',
  '^debian/',
  '(^|/)run\\.n$',
  '(^|/)bootstrap-datepicker/',
  '(^|/)jquery([^.]*)\\.js$',
  '(^|/)jquery\\-\\d\\.\\d+(\\.\\d+)?\\.js$',
  '(^|/)jquery\\-ui(\\-\\d\\.\\d+(\\.\\d+)?)?(\\.\\w+)?\\.(js|css)$',
  '(^|/)jquery\\.(ui|effects)\\.([^.]*)\\.(js|css)$',
  '(^|/)jquery\\.fn\\.gantt\\.js',
  '(^|/)jquery\\.fancybox\\.(js|css)',
  '(^|/)fuelux\\.js',
  '(^|/)jquery\\.fileupload(-\\w+)?\\.js$',
  '(^|/)jquery\\.dataTables\\.js',
  '(^|/)bootbox\\.js',
  '(^|/)pdf\\.worker\\.js',
  '(^|/)slick\\.\\w+.js$',
  '(^|/)Leaflet\\.Coordinates-\\d+\\.\\d+\\.\\d+\\.src\\.js$',
  '(^|/)leaflet\\.draw-src\\.js',
  '(^|/)leaflet\\.draw\\.css',
  '(^|/)Control\\.FullScreen\\.css',
  '(^|/)Control\\.FullScreen\\.js',
  '(^|/)leaflet\\.spin\\.js',
  '(^|/)wicket-leaflet\\.js',
  '(^|/)\\.sublime-project',
  '(^|/)\\.sublime-workspace',
  '(^|/)\\.vscode/',
  '(^|/)prototype(.*)\\.js$',
  '(^|/)effects\\.js$',
  '(^|/)controls\\.js$',
  '(^|/)dragdrop\\.js$',
  '(.*?)\\.d\\.ts$',
  '(^|/)mootools([^.]*)\\d+\\.\\d+.\\d+([^.]*)\\.js$',
  '(^|/)dojo\\.js$',
  '(^|/)MochiKit\\.js$',
  '(^|/)yahoo-([^.]*)\\.js$',
  '(^|/)yui([^.]*)\\.js$',
  '(^|/)ckeditor\\.js$',
  '(^|/)tiny_mce([^.]*)\\.js$',
  '(^|/)tiny_mce/(langs|plugins|themes|utils)',
  '(^|/)ace-builds/',
  '(^|/)fontello(.*?)\\.css$',
  '(^|/)MathJax/',
  '(^|/)Chart\\.js$',
  '(^|/)[Cc]ode[Mm]irror/(\\d+\\.\\d+/)?(lib|mode|theme|addon|keymap|demo)',
  '(^|/)shBrush([^.]*)\\.js$',
  '(^|/)shCore\\.js$',
  '(^|/)shLegacy\\.js$',
  '(^|/)angular([^.]*)\\.js$',
  '(^|/)d3(\\.v\\d+)?([^.]*)\\.js$',
  '(^|/)react(-[^.]*)?\\.js$',
  '(^|/)flow-typed/.*\\.js$',
  '(^|/)modernizr\\-\\d\\.\\d+(\\.\\d+)?\\.js$',
  '(^|/)modernizr\\.custom\\.\\d+\\.js$',
  '(^|/)knockout-(\\d+\\.){3}(debug\\.)?js$',
  '(^|/)docs?/_?(build|themes?|templates?|static)/',
  '(^|/)admin_media/',
  '(^|/)env/',
  '(^|/)fabfile\\.py$',
  '(^|/)waf$',
  '(^|/)\\.osx$',
  '\\.xctemplate/',
  '\\.imageset/',
  '(^|/)Carthage/',
  '(^|/)Sparkle/',
  '(^|/)Crashlytics\\.framework/',
  '(^|/)Fabric\\.framework/',
  '(^|/)BuddyBuildSDK\\.framework/',
  '(^|/)Realm\\.framework',
  '(^|/)RealmSwift\\.framework',
  '(^|/)\\.gitattributes$',
  '(^|/)\\.gitignore$',
  '(^|/)\\.gitmodules$',
  '(^|/)gradlew$',
  '(^|/)gradlew\\.bat$',
  '(^|/)gradle/wrapper/',
  '(^|/)mvnw$',
  '(^|/)mvnw\\.cmd$',
  '(^|/)\\.mvn/wrapper/',
  '-vsdoc\\.js$',
  '\\.intellisense\\.js$',
  '(^|/)jquery([^.]*)\\.validate(\\.unobtrusive)?\\.js$',
  '(^|/)jquery([^.]*)\\.unobtrusive\\-ajax\\.js$',
  '(^|/)[Mm]icrosoft([Mm]vc)?([Aa]jax|[Vv]alidation)(\\.debug)?\\.js$',
  '(^|/)[Pp]ackages/.+\\.\\d+/',
  '(^|/)extjs/.*?\\.js$',
  '(^|/)extjs/.*?\\.xml$',
  '(^|/)extjs/.*?\\.txt$',
  '(^|/)extjs/.*?\\.html$',
  '(^|/)extjs/.*?\\.properties$',
  '(^|/)extjs/\\.sencha/',
  '(^|/)extjs/docs/',
  '(^|/)extjs/builds/',
  '(^|/)extjs/cmd/',
  '(^|/)extjs/examples/',
  '(^|/)extjs/locale/',
  '(^|/)extjs/packages/',
  '(^|/)extjs/plugins/',
  '(^|/)extjs/resources/',
  '(^|/)extjs/src/',
  '(^|/)extjs/welcome/',
  '(^|/)html5shiv\\.js$',
  '(^|/)[Tt]ests?/fixtures/',
  '(^|/)[Ss]pecs?/fixtures/',
  '(^|/)cordova([^.]*)\\.js$',
  '(^|/)cordova\\-\\d\\.\\d(\\.\\d)?\\.js$',
  '(^|/)foundation(\\..*)?\\.js$',
  '(^|/)Vagrantfile$',
  '(^|/)\\.[Dd][Ss]_[Ss]tore$',
  '(^|/)inst/extdata/',
  '(^|/)octicons\\.css',
  '(^|/)sprockets-octicons\\.scss',
  '(^|/)activator$',
  '(^|/)activator\\.bat$',
  '(^|/)proguard\\.pro$',
  '(^|/)proguard-rules\\.pro$',
  '(^|/)puphpet/',
  '(^|/)\\.google_apis/',
  '(^|/)Jenkinsfile$',
  '(^|/)\\.gitpod\\.Dockerfile$',
  '(^|/)\\.github/',
  '(^|/)\\.obsidian/',
  '(^|/)\\.teamcity/',
  '(^|/)xvba_modules/',
]

const VENDOR_REGEXES: RegExp[] = VENDOR_PATTERNS.map((p) => new RegExp(p))

// --- Documentation (documentation.yml) ---

const DOCUMENTATION_PATTERNS: string[] = [
  '^[Dd]ocs?/',
  '(^|/)[Dd]ocumentation/',
  '(^|/)[Gg]roovydoc/',
  '(^|/)[Jj]avadoc/',
  '^[Mm]an/',
  '^[Ee]xamples/',
  '^[Dd]emos?/',
  '(^|/)inst/doc/',
  '(^|/)CITATION(\\.cff|(S)?(\\.(bib|md))?)$',
  '(^|/)CHANGE(S|LOG)?(\\.|$)',
  '(^|/)CONTRIBUTING(\\.|$)',
  '(^|/)COPYING(\\.|$)',
  '(^|/)INSTALL(\\.|$)',
  '(^|/)LICEN[CS]E(\\.|$)',
  '(^|/)[Ll]icen[cs]e(\\.|$)',
  '(^|/)README(\\.|$)',
  '(^|/)[Rr]eadme(\\.|$)',
  '^[Ss]amples?/',
]

const DOCUMENTATION_REGEXES: RegExp[] = DOCUMENTATION_PATTERNS.map((p) => new RegExp(p))

// --- Public API ---

/**
 * Classify a file path using Linguist's built-in path rules. Returns only
 * the attributes that the rules explicitly set; a file that doesn't match
 * any rule returns `{}`.
 *
 * The caller is responsible for merging this with other attribute sources
 * (e.g., `.gitattributes`).
 */
export function classifyByPath(path: string): Partial<FileAttrs> {
  const result: Partial<FileAttrs> = {}
  if (hasGeneratedExtension(path) || GENERATED_REGEXES.some((r) => r.test(path))) {
    result.generated = true
  }
  if (VENDOR_REGEXES.some((r) => r.test(path))) {
    result.vendored = true
  }
  if (DOCUMENTATION_REGEXES.some((r) => r.test(path))) {
    result.documentation = true
  }
  return result
}

/** Apply `classifyByPath` to many files, dropping entries with no matches. */
export function classifyByPaths(paths: string[]): Record<string, Partial<FileAttrs>> {
  const result: Record<string, Partial<FileAttrs>> = {}
  for (const path of paths) {
    const attrs = classifyByPath(path)
    if (Object.keys(attrs).length > 0) result[path] = attrs
  }
  return result
}
