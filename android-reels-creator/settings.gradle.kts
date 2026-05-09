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
                username = System.getenv("GPR_USER")
                    ?: extra.properties["gpr.user"]?.toString() ?: ""
                password = System.getenv("GPR_TOKEN")
                    ?: extra.properties["gpr.key"]?.toString() ?: ""
            }
        }
    }
}

rootProject.name = "ReelsCreator"
include(":app")
