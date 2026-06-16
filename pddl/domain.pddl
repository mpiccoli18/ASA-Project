(define (domain deliveroo)
  (:requirements :strips :typing)
  
  ;; The "things" in our world
  (:types location parcel)
  
  ;; The facts that can be true or false at any given time
  (:predicates 
    (at-agent ?loc - location)
    (at-parcel ?p - parcel ?loc - location)
    (carrying ?p - parcel)
    (delivered ?p - parcel)
    (connected ?from - location ?to - location)
    (is-delivery-zone ?loc - location)
  )

  ;; ACTION: Move from one adjacent tile to another
  (:action move
    :parameters (?from - location ?to - location)
    :precondition (and 
        (at-agent ?from)
        (connected ?from ?to)
    )
    :effect (and 
        (at-agent ?to)
        (not (at-agent ?from))
    )
  )

  ;; ACTION: Pick up a parcel
  (:action pickup
    :parameters (?p - parcel ?loc - location)
    :precondition (and 
        (at-agent ?loc)
        (at-parcel ?p ?loc)
    )
    :effect (and 
        (carrying ?p)
        (not (at-parcel ?p ?loc))
    )
  )

  ;; ACTION: Deliver a parcel to a valid delivery zone
  (:action drop-at-delivery
    :parameters (?p - parcel ?loc - location)
    :precondition (and 
        (at-agent ?loc)
        (carrying ?p)
        (is-delivery-zone ?loc)
    )
    :effect (and 
        (not (carrying ?p))
        (delivered ?p)
    )
  )
)