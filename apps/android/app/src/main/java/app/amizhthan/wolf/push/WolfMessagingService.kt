package app.amizhthan.wolf.push

import app.amizhthan.wolf.AppGraph
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Where wake-ups arrive.
 *
 * A message that is not WOLF's content-free wake-up is ignored: anything else in a push payload is not something
 * this app acts on. The work happens within the few seconds Android allows a push handler, on its own thread.
 */
class WolfMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // Not kept here: the registrar asks the push service for the current token itself.
        val graph = AppGraph.get(applicationContext)
        scope.launch { graph.pushRegistrar.sync() }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data[KIND] != WAKE) return
        val graph = AppGraph.get(applicationContext)
        runBlocking { withTimeoutOrNull(WAKE_BUDGET_MS) { graph.wakeHandler.onWake() } }
    }

    private companion object {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        const val KIND = "kind"
        const val WAKE = "wolf.wake"

        /** Android gives a high-priority message's handler about twenty seconds. */
        const val WAKE_BUDGET_MS = 15_000L
    }
}
