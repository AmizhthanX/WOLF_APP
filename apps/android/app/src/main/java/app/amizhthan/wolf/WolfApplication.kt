package app.amizhthan.wolf

import android.app.Application

/** Builds the app's long-lived objects — Firebase among them, when configured — before any screen or wake-up needs them. */
class WolfApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AppGraph.get(this)
    }
}
