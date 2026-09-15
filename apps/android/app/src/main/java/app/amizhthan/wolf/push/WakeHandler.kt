package app.amizhthan.wolf.push

import app.amizhthan.wolf.api.NotificationView
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.session.SessionState

/** Showing a notification on this phone. */
interface Notifier {
    fun show(notification: NotificationView)

    /** "And N more", when a wake-up finds more news than is worth a notification each. */
    fun showSummary(more: Int)

    /** A wake-up arrived while WOLF is locked: something may be new, and nothing can be fetched to say what. */
    fun showLocked() {}
}

/** Which notifications this phone has already shown. Ids only. */
interface SeenStore {
    fun seen(): Set<String>

    fun remember(ids: Collection<String>)
}

/**
 * What a wake-up does: fetch the inbox from WOLF, over this phone's own authenticated connection, and show what is
 * new.
 *
 * The wake-up itself said nothing, so everything shown comes from WOLF, never from the push service. A phone with
 * no credentials shows nothing and asks nothing. A fetch that fails shows nothing and remembers nothing, so the
 * next wake-up — or opening the app — finds the same news. Notifications already read, or already shown on this
 * phone, are not shown again. A locked WOLF fetches nothing: it posts one notice that something may be new, and the
 * owner unlocks to see what.
 */
class WakeHandler(
    private val api: WolfApi,
    private val session: SessionManager,
    private val notifier: Notifier,
    private val store: SeenStore,
    private val maxShown: Int = 4,
) {
    /** Returns how many notifications were new. */
    suspend fun onWake(): Int {
        if (session.state.value !is SessionState.SignedIn && !session.restore()) {
            if (session.state.value is SessionState.Locked) notifier.showLocked()
            return 0
        }

        val inbox = try {
            session.authorized { api.listNotifications(it) }
        } catch (_: WolfApiException) {
            // Locked while this wake-up was on its way: say that something came, and nothing about what.
            if (session.state.value is SessionState.Locked) notifier.showLocked()
            return 0
        }

        val seen = store.seen()
        val fresh = inbox.notifications.filter { it.readAt == null && it.id !in seen }.sortedBy { it.occurredAt }
        if (fresh.isEmpty()) return 0

        // The latest few each get a notification; the rest are counted rather than dropped.
        fresh.takeLast(maxShown).forEach(notifier::show)
        if (fresh.size > maxShown) notifier.showSummary(fresh.size - maxShown)

        store.remember(fresh.map { it.id })
        return fresh.size
    }
}
