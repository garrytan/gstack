pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // FFmpegKit 6.0+ is only distributed via GitHub Packages (not Maven Central).
        // In CI, GPR_USER/GPR_TOKEN are injected from GITHUB_ACTOR/GITHUB_TOKEN.
        // For local builds: add gpr.user and gpr.key to ~/.gradle/gradle.properties
        maven {
            url = uri("https://maven.pkg.github.com/arthenica/ffmpeg-kit")
            credentials {
                username = providers.environmentVariable("GPR_USER")
                    .orElse(providers.gradleProperty("gpr.user"))
                    .orElse("").get()
                password = providers.environmentVariable("GPR_TOKEN")
                    .orElse(providers.gradleProperty("gpr.key"))
                    .orElse("").get()
            }
        }
    }
}

rootProject.name = "ReelsCreator"
include(":app")
